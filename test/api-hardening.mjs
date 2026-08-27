/**
 * Two holes in the local HTTP surface. It binds 127.0.0.1 and only the four
 * /api/internal/* routes check a token, so loopback is the whole boundary —
 * which makes both of these reachable by any local process.
 *
 * 1. GET /api/bots/:id/screen joined the route param straight into a path.
 *    Express matches the still-ENCODED pathname and decodes params afterwards,
 *    so `%2F..%2F` survived matching and then became a real traversal:
 *    path.join walked out of data/screens and served any .png on the machine.
 *    The 404-vs-200 split also answered "does this file exist" for anything
 *    ending .png. Every other :id route resolves through a registry lookup
 *    (store.getBot, computers.getComputer) and just 404s on a junk id; this was
 *    the only one putting a raw param into a path.
 *
 * 2. No error middleware was registered and NODE_ENV is never set anywhere in
 *    the repo, so express handed unhandled throws to finalhandler, which
 *    returns err.stack in the BODY for any env other than "production" —
 *    disclosing the install path and the user's home directory.
 *
 * Runs against a real server on a temp data dir. Never touches live data.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempData } from "../testing/e2e/harness.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS", name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log("FAIL", name, "-", err.message);
  }
}

await withTempData(async ({ base, data }) => {
  // A real screenshot, so the legitimate path is proven to still work — a test
  // that only checks the 404s would pass against a route that always 404s.
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000a49444154789c6360000002000100ffff0300000600" +
      "05572f9a880000000049454e44ae426082",
    "hex",
  );
  await fs.mkdir(path.join(data, "screens"), { recursive: true });
  await fs.writeFile(path.join(data, "screens", "realbot.png"), PNG);
  // The file a traversal would be aiming for, planted OUTSIDE data/.
  const outside = path.join(data, "..", `sub8-outside-${process.pid}.png`);
  await fs.writeFile(outside, PNG);

  await test("a legitimate screen still serves", async () => {
    const r = await fetch(`${base}/api/bots/realbot/screen`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal((await r.arrayBuffer()).byteLength, PNG.length);
  });

  await test("an encoded traversal cannot escape data/screens", async () => {
    const target = path.basename(outside, ".png");
    for (const id of [
      `..%2F${target}`,
      `..%2f..%2f${target}`,
      `%2E%2E%2F${target}`,
      `..%252F${target}`,
      `subdir%2F..%2F..%2F${target}`,
    ]) {
      const r = await fetch(`${base}/api/bots/${id}/screen`);
      assert.equal(r.status, 404, `traversal served a file for id ${id}`);
    }
  });

  await test("a traversal at a well-known path is refused too", async () => {
    for (const id of ["..%2F..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "..%2F..%2Fpackage"]) {
      assert.equal((await fetch(`${base}/api/bots/${id}/screen`)).status, 404, id);
    }
  });

  await test("a missing screen is still a plain 404", async () => {
    assert.equal((await fetch(`${base}/api/bots/nosuchbot/screen`)).status, 404);
  });

  // 2. The error handler.
  await test("an unhandled throw returns JSON, not a stack trace", async () => {
    const r = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ members: [null] }),
    });
    const body = await r.text();
    assert.notEqual(r.status, 200);
    assert.equal(body.includes("/Users/"), false, `the response leaked a filesystem path:\n${body.slice(0, 300)}`);
    assert.equal(/\bat \w+.*\(.*:\d+:\d+\)/.test(body), false, "the response carried a stack frame");
    assert.equal(body.includes("node_modules"), false, "the response named node_modules");
    if (r.status === 500) {
      assert.doesNotMatch(r.headers.get("content-type") || "", /text\/html/, "500s must not render express's HTML page");
      assert.equal(JSON.parse(body).ok, false);
    }
  });

  // 3. Cross-origin state change.
  //
  // Loopback was the whole boundary, and it is not one against a page the user
  // merely visits: a cross-origin <form method="POST"> needs no preflight, and
  // these routes need no body and no header a browser withholds. The opaque
  // response does not matter — the harm is the side effect.
  const EVIL = "https://evil.example";
  const destructive = [
    "/api/computers/pause-all",
    "/api/docker/recover",
    "/api/computers/previews",
    "/api/bots",
    "/api/teams",
  ];

  await test("a foreign page cannot POST to the destructive routes", async () => {
    for (const url of destructive) {
      // Exactly what a cross-origin form submission looks like on the wire.
      const r = await fetch(`${base}${url}`, {
        method: "POST",
        headers: { origin: EVIL, "content-type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
      assert.equal(r.status, 403, `${url} accepted a cross-origin form POST (${r.status})`);
    }
  });

  await test("no bots were created by those attempts", async () => {
    const r = await fetch(`${base}/api/bots`);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : body.bots || [];
    assert.equal(rows.length, 0, `${rows.length} bot(s) were created by the refused requests`);
  });

  await test("DELETE and PATCH are covered too, not just POST", async () => {
    for (const [method, url] of [
      ["DELETE", "/api/bots/whatever"],
      ["PATCH", "/api/bots/whatever"],
      ["PUT", "/api/settings"],
    ]) {
      const r = await fetch(`${base}${url}`, { method, headers: { origin: EVIL } });
      assert.equal(r.status, 403, `${method} ${url} was not refused`);
    }
  });

  // The app itself, and every non-browser caller, must be untouched.
  await test("the app's own origin still works", async () => {
    const r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ sidebarSections: ["a"] }),
    });
    assert.equal(r.status, 200, "same-origin write was refused");
  });

  await test("a caller with no Origin still works", async () => {
    // curl, the Electron shell, mcp-sub8 over SUB8_INTERNAL_URL.
    const r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sidebarSections: ["b"] }),
    });
    assert.equal(r.status, 200, "a headless caller was refused");
  });

  await test("reads from anywhere are still allowed", async () => {
    const r = await fetch(`${base}/api/settings`, { headers: { origin: EVIL } });
    assert.equal(r.status, 200, "a GET was refused; only state changes should be");
  });

  // 4. /api/dictate: two ways it used to answer nothing at all.
  //
  // express.json() drains the stream for a JSON content-type, so the route's
  // "end" listener was attached to an already-ended readable and never fired —
  // no response, and the socket held until requestTimeout, which is 900s. And
  // the raw read had no ceiling: express.json's 8mb limit only covers what IT
  // parses, so any other content-type accumulated the whole upload in memory.
  const withTimeout = async (init, ms = 8000) => {
    try {
      const r = await fetch(`${base}/api/dictate`, { ...init, signal: AbortSignal.timeout(ms) });
      return { status: r.status, body: await r.text() };
    } catch (err) {
      return { status: null, error: String(err?.name || err) };
    }
  };

  await test("a JSON content-type is answered, not left hanging", async () => {
    const r = await withTimeout({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio: "nope" }),
    });
    assert.notEqual(r.status, null, `no response within 8s (${r.error}) — the socket was held`);
    assert.equal(r.status, 415, `expected 415, got ${r.status}`);
  });

  await test("a short raw body is still the old 400", async () => {
    const r = await withTimeout({
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: Buffer.alloc(64),
    });
    assert.notEqual(r.status, null, `no response within 8s (${r.error})`);
    assert.equal(r.status, 400);
  });

  await test("an oversized upload is cut off rather than buffered whole", async () => {
    // 30 MB against a 25 MB ceiling. Either the socket is destroyed mid-upload
    // (fetch surfaces that as an error) or we get a non-200 — what must NOT
    // happen is the server accepting and buffering all of it.
    const r = await withTimeout(
      { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.alloc(30 * 1024 * 1024) },
      20_000,
    );
    assert.notEqual(r.status, 200, "a 30MB upload was accepted past the ceiling");
  });

  // 5. POST /api/computers/:id/start with a botId that belongs elsewhere.
  //
  // The `start` branch took `req.body.botId` and re-pointed that bot's
  // vm.container/volume/computerId at THIS computer. The other computer was
  // never touched, so its container kept running with nothing referring to it
  // and the bot's working state in that volume became unreachable from the app.
  // Its sibling `attach` branch has always refused this with a 409; `start`
  // did not.
  await test("starting a computer cannot steal a bot that belongs to another", async () => {
    const r = await fetch(`${base}/api/computers/does-not-exist/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "also-does-not-exist" }),
    });
    // With no such computer this is a 404 either way — what must never happen
    // is a 200 that silently re-points a bot. The guard itself is pinned below
    // against the source, since building two real computers needs Docker.
    assert.notEqual(r.status, 200, "start accepted a computer that does not exist");
  });

  await test("the start branch carries the same 409 guard as attach", async () => {
    const src = await fs.readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
    const startBranch = src.slice(src.indexOf('else if (action === "start")'), src.indexOf('else if (action === "attach")'));
    assert.ok(startBranch.length > 0, "the start branch moved — this assertion needs updating");
    assert.match(
      startBranch,
      /already has a computer/,
      "start must refuse a bot already attached to a different computer, as attach does",
    );
  });

  await fs.rm(outside, { force: true });
  await test("the vault routes refuse a non-browser caller", async () => {
    // A bot's container reaches the host API through the VM gateway, and the
    // CSRF middleware exempts GETs -- so `curl .../api/vault/accounts/<id>/reveal`
    // returned plaintext passwords for accounts the bot was never granted.
    for (const url of ["/api/vault", "/api/vault/accounts/whatever/reveal"]) {
      const r = await fetch(`${base}${url}`);
      assert.equal(r.status, 403, `${url} must refuse a header-less caller`);
    }
    // The desktop UI still works: Chromium always sends Sec-Fetch-Site, and a
    // same-origin Referer is accepted as the fallback.
    assert.notEqual(
      (await fetch(`${base}/api/vault`, { headers: { "sec-fetch-site": "same-origin" } })).status,
      403,
    );
    assert.notEqual((await fetch(`${base}/api/vault`, { headers: { referer: `${base}/` } })).status, 403);
    // A cross-site browser request is still refused.
    assert.equal((await fetch(`${base}/api/vault`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    // Unrelated routes are untouched.
    assert.notEqual((await fetch(`${base}/api/health`)).status, 403);
  });

});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} failed` : `ok api-hardening (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
