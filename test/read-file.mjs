import assert from "node:assert/strict";
import {
  resolveReadPath,
  readFile,
  isImagePath,
  webFetch,
  assertPublicHttpUrl,
  htmlToMarkdown,
} from "../server/read-file.mjs";

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok  ${name}`);
    })
    .catch((err) => {
      console.error("not ok " + name);
      throw err;
    });
}

const bot = { id: "e0880729-a7f3-46a2-bead-ceecaa3f76fc", name: "Lead" };

await test("workspace paths are allowed", () => {
  assert.equal(resolveReadPath("/config/workspace/pipeline.md"), "/config/workspace/pipeline.md");
  assert.equal(resolveReadPath("workspace/pipeline.md"), "/config/workspace/pipeline.md");
});

await test("relative paths with bot land in the agent folder", () => {
  assert.equal(
    resolveReadPath("memory/profile.md", { bot }),
    `/config/agent-data/agents/${bot.id}/memory/profile.md`,
  );
});

await test("host Mac paths are rejected", () => {
  assert.throws(() => resolveReadPath("/Users/someone/secret"), /must be under/);
  assert.throws(() => resolveReadPath("/Users"), /must be under/);
  assert.throws(() => resolveReadPath("/etc/passwd"), /must be under/);
  assert.throws(() => resolveReadPath("/config/../Users/someone/secret"), /must be under|invalid path/);
  assert.throws(() => resolveReadPath("../../../../etc/passwd"), /must be under|invalid path/);
});

await test("empty path is invalid", () => {
  assert.throws(() => resolveReadPath(""), /path required/);
  assert.throws(() => resolveReadPath("   "), /path required/);
});

await test("read text files from an injected map", async () => {
  const files = {
    "/config/workspace/notes.md": "# Hello\n",
  };
  const got = await readFile("/config/workspace/notes.md", { files });
  assert.equal(got.kind, "text");
  assert.equal(got.path, "/config/workspace/notes.md");
  assert.equal(got.text, "# Hello\n");
});

await test("images return a stub and are not read", async () => {
  assert.equal(isImagePath("/config/workspace/shot.PNG"), true);
  const got = await readFile("/config/workspace/shot.png", {
    files: { "/config/workspace/shot.png": "not-bytes" },
    readText: () => {
      throw new Error("should not read image bytes");
    },
  });
  assert.deepEqual(got, { kind: "image", path: "/config/workspace/shot.png" });
});

await test("pdfs return a stub", async () => {
  const got = await readFile("/config/workspace/doc.pdf");
  assert.deepEqual(got, { kind: "pdf", path: "/config/workspace/doc.pdf" });
});

await test("missing text file throws", async () => {
  await assert.rejects(() => readFile("/config/workspace/missing.md", { files: {} }), /file not found/);
});

await test("readFile rejects host Mac paths", async () => {
  await assert.rejects(() => readFile("/Users/someone/secret", { files: {} }), /must be under/);
});

await test("webFetch blocks file: and localhost", async () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /file:/);
  assert.throws(() => assertPublicHttpUrl("FILE://localhost/tmp/x"), /file:/);
  assert.throws(() => assertPublicHttpUrl("http://localhost/secret"), /localhost/);
  assert.throws(() => assertPublicHttpUrl("https://127.0.0.1/x"), /localhost/);
  assert.throws(() => assertPublicHttpUrl("http://[::1]/"), /localhost/);
  assert.equal(assertPublicHttpUrl("https://example.com/x").hostname, "example.com");
  await assert.rejects(() => webFetch("file:///etc/passwd"), /file:/);
  await assert.rejects(() => webFetch("http://localhost:8080/x"), /localhost/);
  await assert.rejects(() => webFetch("http://127.0.0.1/x"), /localhost/);
});

await test("htmlToMarkdown is markdown-ish", () => {
  const md = htmlToMarkdown(`<html><head><title>Docs</title></head><body>
    <h1>Hello</h1>
    <p>See <a href="https://example.com">ex</a>.</p>
    <ul><li>one</li><li>two</li></ul>
  </body></html>`);
  assert.match(md, /^# Docs/m);
  assert.match(md, /# Hello/);
  assert.match(md, /\[ex\]\(https:\/\/example.com\)/);
  assert.match(md, /^- one/m);
});

await test("webFetch returns markdown-ish text", async () => {
  const fetch = async (url, opts) => {
    assert.equal(opts.redirect, "manual");
    assert.match(String(url), /example\.com\/page$/);
    return new Response(
      `<html><head><title>Page</title></head><body><h1>Hello</h1><p>World</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  const got = await webFetch("https://example.com/page", { fetch });
  assert.equal(got.kind, "web");
  assert.equal(got.url, "https://example.com/page");
  assert.equal(got.status, 200);
  assert.match(got.text, /Source: https:\/\/example.com\/page/);
  assert.match(got.text, /# Hello/);
  assert.match(got.text, /World/);
});

await test("webFetch follows a public redirect", async () => {
  const fetch = async (url) => {
    if (String(url).endsWith("/start")) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/ok" } });
    }
    return new Response("# ok\n", { status: 200, headers: { "content-type": "text/markdown" } });
  };
  const got = await webFetch("https://example.com/start", { fetch });
  assert.equal(got.finalUrl, "https://example.com/ok");
  assert.match(got.text, /# ok/);
});

await test("webFetch refuses a redirect to localhost", async () => {
  const fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
  await assert.rejects(() => webFetch("https://example.com/x", { fetch }), /localhost/);
});

console.log("ok read-file");
