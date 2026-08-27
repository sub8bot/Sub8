/**
 * web_fetch is the one tool that makes the host itself talk to a URL the model
 * chose, so the blocklist is a security boundary, not a nicety. This started as
 * test/web-fetch.mjs, written because nothing covered the guard directly —
 * test/read-file.mjs only reaches it through read-file's re-export, and
 * test/mcp-remote.mjs only through assertMcpUrl.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, htmlToMarkdown, webFetch } from "../dist/index.js";

test("public http(s) URLs pass", () => {
  for (const url of [
    "https://example.com/x?a=1",
    "http://example.com./",
    "http://172.15.0.1/",
    "http://172.32.0.1/",
    "http://11.0.0.1/",
  ]) {
    assert.ok(assertPublicHttpUrl(url).href, `${url} is public and should pass`);
  }
});

test("the blocklist refuses every private shape, in every spelling", () => {
  const blocked = [
    ["", /url required/],
    ["not a url", /invalid url/],
    ["file:///etc/passwd", /file:/],
    ["data:text/html,hi", /only http\/https/],
    ["ftp://example.com/x", /only http\/https/],
    ["https://user:pw@example.com/", /credentials/],
    ["http://localhost:8787/", /localhost/],
    ["http://LOCALHOST/", /localhost/],
    ["http://sub.localhost/", /localhost/],
    ["http://127.0.0.1:8787/api/bots", /localhost/],
    // WHATWG normalises these to 127.0.0.1 before the guard ever sees them.
    ["http://127.1/", /localhost/],
    ["http://2130706433/", /localhost/],
    ["http://0177.0.0.1/", /localhost/],
    ["http://[::1]/", /localhost/],
    // IPv4-mapped IPv6. The URL parser rewrites the dotted form to hex, so the
    // guard has to understand ::ffff:7f00:1, not just ::ffff:127.0.0.1.
    ["http://[::ffff:127.0.0.1]/", /localhost/],
    ["http://[::ffff:7f00:1]/", /localhost/],
    ["http://[::ffff:10.0.0.1]/", /private/],
    ["http://[::ffff:192.168.1.1]/", /private/],
    ["http://0.0.0.0/", /private/],
    ["http://10.0.0.1/", /private/],
    ["http://172.16.0.1/", /private/],
    ["http://172.31.255.254/", /private/],
    ["http://192.168.1.1/", /private/],
    ["http://169.254.169.254/latest/meta-data/", /private/],
    ["http://metadata.google.internal/", /private/],
    ["http://[fd00::1]/", /private/],
    ["http://[fe80::1]/", /private/],
    ["http://[::]/", /private/],
  ];
  for (const [url, re] of blocked) {
    assert.throws(() => assertPublicHttpUrl(url), re, `${url} must be blocked`);
  }
});

test("htmlToMarkdown keeps the structure and drops the machinery", () => {
  const md = htmlToMarkdown(`
<html><head><title>Docs &amp; Notes</title><style>body{color:red}</style></head>
<body>
<!-- comment -->
<script>alert(1)</script>
<h2>Install</h2>
<p>Run <code>npm i</code> and read the <a href="https://x.test/g">guide</a>.</p>
<ul><li>one</li><li>two</li></ul>
<pre>$ npm test
ok</pre>
<p><strong>bold</strong> and <em>italic</em></p>
<img src="/logo.png" alt="Logo">
<hr>
</body></html>`);

  assert.match(md, /^# Docs & Notes/, "the <title> becomes the leading heading");
  assert.match(md, /## Install/);
  assert.match(md, /`npm i`/);
  assert.match(md, /\[guide\]\(https:\/\/x\.test\/g\)/);
  assert.match(md, /- one\n- two/);
  assert.match(md, /```\n\$ npm test\nok\n```/);
  assert.match(md, /\*\*bold\*\* and \*italic\*/);
  assert.match(md, /!\[Logo\]\(\/logo\.png\)/);
  assert.match(md, /\n\n---$/, "<hr> becomes a rule");
  assert.equal(md.includes("alert(1)"), false, "script bodies are dropped");
  assert.equal(md.includes("color:red"), false, "style bodies are dropped");
  assert.equal(md.includes("comment"), false, "comments are dropped");
  assert.equal(/\n{3,}/.test(md), false, "blank runs collapse");
  assert.equal(htmlToMarkdown("<p>&#65;&#x42;&nbsp;&unknown;</p>"), "AB &unknown;");
  // A page whose h1 already says the title does not get it twice.
  assert.equal(htmlToMarkdown("<head><title>Only</title></head><h1>Only</h1>"), "# Only");
});

function ok(body, contentType, extra = {}) {
  return new Response(body, { status: 200, headers: { "content-type": contentType }, ...extra });
}

test("the body becomes markdown, JSON stays fenced, and every reply names its source", async () => {
  const html = await webFetch("https://x.test/page", {
    fetch: async () => ok("<html><head><title>T</title></head><body><p>hello</p></body></html>", "text/html; charset=utf-8"),
  });
  assert.equal(html.kind, "web");
  assert.equal(html.status, 200);
  assert.equal(html.url, "https://x.test/page");
  assert.equal(html.finalUrl, "https://x.test/page");
  assert.match(html.text, /^Source: https:\/\/x\.test\/page\n\n# T\n\nhello$/);

  const json = await webFetch("https://x.test/api", { fetch: async () => ok('{"a":1}', "application/json") });
  assert.match(json.text, /```json\n\{"a":1\}\n```/);

  const plain = await webFetch("https://x.test/robots.txt", { fetch: async () => ok("  User-agent: *  ", "text/plain") });
  assert.match(plain.text, /Source: https:\/\/x\.test\/robots\.txt\n\nUser-agent: \*/);

  // A body with no content-type that starts with <html is still HTML.
  const sniffed = await webFetch("https://x.test/sniff", {
    fetch: async () => ok("<html><body><p>sniffed</p></body></html>", ""),
  });
  assert.match(sniffed.text, /sniffed/);
});

test("redirects are followed by hand so every hop is re-checked", async () => {
  const hops = [];
  const redirected = await webFetch("https://x.test/a", {
    fetch: async (url) => {
      hops.push(url);
      if (url.endsWith("/a")) return new Response("", { status: 301, headers: { location: "/b" } });
      return ok("done", "text/plain");
    },
  });
  assert.deepEqual(hops, ["https://x.test/a", "https://x.test/b"]);
  assert.equal(redirected.url, "https://x.test/a");
  assert.equal(redirected.finalUrl, "https://x.test/b");

  await assert.rejects(
    () =>
      webFetch("https://x.test/a", {
        fetch: async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }),
      }),
    /private URLs are blocked/,
    "a redirect into link-local must be refused",
  );

  await assert.rejects(
    () =>
      webFetch("https://x.test/a", {
        fetch: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1:8787/" } }),
      }),
    /localhost URLs are blocked/,
  );

  await assert.rejects(
    () => webFetch("https://x.test/a", { fetch: async () => new Response("", { status: 302 }) }),
    /redirect without location/,
  );

  await assert.rejects(
    () =>
      webFetch("https://x.test/a", {
        maxRedirects: 1,
        fetch: async () => new Response("", { status: 307, headers: { location: "https://x.test/loop" } }),
      }),
    /too many redirects/,
  );
});

test("a failed hop names what went wrong", async () => {
  await assert.rejects(
    () => webFetch("https://x.test/gone", { fetch: async () => new Response("nope", { status: 404 }) }),
    /web_fetch failed \(404\)/,
  );

  await assert.rejects(
    () =>
      webFetch("https://x.test/boom", {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    /web_fetch failed: ECONNREFUSED/,
  );

  await assert.rejects(
    () =>
      webFetch("https://x.test/slow", {
        fetch: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    /web_fetch failed \(timeout\)/,
  );
});

test("the size cap truncates instead of swallowing the page whole", async () => {
  const big = await webFetch("https://x.test/big", {
    maxBytes: 32,
    fetch: async () => ok("x".repeat(5000), "text/plain"),
  });
  assert.match(big.text, /\[truncated\]$/);
  assert.ok(big.text.length < 200, "the cap actually truncates");
});

/* -------------------------------------------- the blocklist, second pass */

// A hostname may spell the root label more than once. The guard stripped one
// trailing dot, so `127.0.0.1.` still had to match a rule — and it matches
// none, because ipv4Parts sees five parts. Every one of these reached the host
// before the fix; the first three are the loopback and RFC1918 ranges the whole
// blocklist exists for.
test("a hostname with more than one trailing dot is still the same host", () => {
  for (const [url, re] of [
    ["http://127.0.0.1../", /localhost/],
    ["http://localhost../", /localhost/],
    ["http://10.0.0.1../", /private/],
    ["http://192.168.1.1.../", /private/],
    ["http://169.254.169.254../", /private/],
    ["http://172.16.0.1..../", /private/],
    // One trailing dot was already handled for the IP forms, but reported the
    // wrong reason for the name form.
    ["http://localhost./", /localhost/],
    ["http://127.0.0.1./", /localhost/],
  ]) {
    assert.throws(() => assertPublicHttpUrl(url), re, `${url} must be blocked`);
  }
  // ...and a PUBLIC host keeps passing, dots and all: this is a normalisation
  // fix, not a new rule, so it must not start refusing ordinary FQDNs.
  for (const url of ["http://example.com./", "http://example.com../", "http://a.b.example.com./"]) {
    assert.ok(assertPublicHttpUrl(url).href, `${url} is public and must still pass`);
  }
});

test("the spellings the URL parser rewrites before the guard ever runs", () => {
  // Every one of these is normalised by WHATWG into a form the blocklist can
  // read. The risk is the reverse: a form it normalises into something the
  // blocklist does NOT recognise.
  for (const [url, re] of [
    // Fully-written IPv6 loopback collapses to ::1.
    ["http://[0:0:0:0:0:0:0:1]/", /localhost/],
    // The dotted IPv4-mapped form becomes hex in EVERY range, not just 127/8.
    ["http://[0:0:0:0:0:ffff:127.0.0.1]/", /localhost/],
    ["http://[::ffff:169.254.169.254]/", /private/],
    ["http://[::ffff:172.16.0.1]/", /private/],
    ["http://[::FFFF:7F00:1]/", /localhost/],
    // fc00::/7 is unique-local, exactly like the fd00:: half already covered.
    ["http://[fc00::1]/", /private/],
    ["http://[fe80::1234:5678]/", /private/],
    // IDNA maps fullwidth digits onto ASCII, so this IS 127.0.0.1.
    ["http://１２７.0.0.1/", /localhost/],
    // Tab/newline/CR are stripped from a URL before the host is parsed.
    ["http://127.0.0\n.1/", /localhost/],
    ["http://loc\talhost/", /localhost/],
    // Whitespace around the whole thing is trimmed by the guard itself.
    ["  http://127.0.0.1/  ", /localhost/],
  ]) {
    assert.throws(() => assertPublicHttpUrl(url), re, `${url} must be blocked`);
  }
});

test("credentials are refused in every spelling, and the host is judged first", () => {
  // `u.username || u.password` — a bare username with no password, and a bare
  // password with no username, are both credentials.
  assert.throws(() => assertPublicHttpUrl("https://user@example.com/"), /credentials/);
  assert.throws(() => assertPublicHttpUrl("https://:pw@example.com/"), /credentials/);
  assert.throws(() => assertPublicHttpUrl("https://user:@example.com/"), /credentials/);
  // The classic confusion: everything before the LAST @ is credentials, so the
  // host here is the private one and the host check has to win.
  assert.throws(() => assertPublicHttpUrl("https://example.com@127.0.0.1/"), /localhost/);
  assert.throws(() => assertPublicHttpUrl("https://user:pw@169.254.169.254/"), /private/);
  // ...and the reverse reads as a public host with a silly username.
  assert.throws(() => assertPublicHttpUrl("https://127.0.0.1@example.com/"), /credentials/);
});

test("a port is not part of the decision, in either direction", () => {
  // Deliberate and worth knowing: the guard filters HOSTS, not ports. A public
  // host on any port is allowed, including ports that mean something on this
  // machine — the protection there is that the host is not this machine.
  for (const url of ["http://example.com:22/", "http://example.com:3011/", "https://example.com:8787/"]) {
    assert.equal(assertPublicHttpUrl(url).hostname, "example.com", `${url} passes`);
  }
  // And a port never rescues a private host.
  for (const url of ["http://127.0.0.1:443/", "http://10.0.0.1:80/", "http://[::1]:8080/"]) {
    assert.throws(() => assertPublicHttpUrl(url), /blocked/, `${url} must be blocked`);
  }
});

// DEFECT, reported not fixed: the guard is a string match on the hostname and
// never resolves it, so any public name that resolves into a private range
// walks straight through — 127.0.0.1.nip.io and localtest.me are public
// wildcard DNS services that do exactly this, and a hostile page only needs to
// control one A record. Closing it means resolving the name and re-checking
// every address before connecting (and again after, for DNS rebinding), which
// is an async redesign of assertPublicHttpUrl plus a custom agent on the fetch
// — not a change to make from a test file.
// assertPublicHttpUrl is a pure STRING match and stays that way — it is sync and
// called from places that cannot await. So a public name resolving into a
// private range walks past it: 127.0.0.1.nip.io and localtest.me both answer
// loopback, and the local API on :8787 serves /api/bots and /api/settings with
// no auth. The literal http://127.0.0.1:8787 is blocked; its DNS spelling was
// not. webFetch now resolves the host and re-runs the same rules on every
// address, which is where an await is available.
test("the sync guard is still string-only — this is why webFetch resolves", () => {
  assert.ok(assertPublicHttpUrl("http://127.0.0.1.nip.io/").href, "sync guard cannot resolve, by design");
});

test("a hostname that resolves into a private range is refused before any request", async () => {
  const reached = [];
  const spy = async (u) => {
    reached.push(u);
    return ok("should never be fetched", "text/plain");
  };
  for (const [host, address] of [
    ["evil.example", "127.0.0.1"],
    ["evil.example", "10.0.0.1"],
    ["evil.example", "169.254.169.254"],
    ["evil.example", "::1"],
    ["evil.example", "192.168.1.1"],
  ]) {
    await assert.rejects(
      () => webFetch(`http://${host}:8787/api/bots`, { fetch: spy, lookup: async () => [{ address }] }),
      /resolves to/,
      `${address} slipped through`,
    );
  }
  assert.deepEqual(reached, [], "a blocked host must never be requested");
});

// Fail OPEN when the name does not resolve: nothing can be reached, the fetch
// that follows fails on its own, and this is what lets the tests above use
// names like x.test without touching the network.
test("a name that does not resolve is not treated as private", async () => {
  const res = await webFetch("https://x.test/page", {
    lookup: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
    fetch: async () => ok("hello", "text/plain"),
  });
  assert.match(res.text, /hello/);
});

// A public first hop that redirects to a private-resolving host must be caught
// at the hop, not after.
test("every redirect hop is resolved, not just the first", async () => {
  const reached = [];
  await assert.rejects(
    () =>
      webFetch("https://safe.test/a", {
        lookup: async (host) => [{ address: host === "safe.test" ? "93.184.216.34" : "127.0.0.1" }],
        fetch: async (u) => {
          reached.push(u);
          return u.includes("/a")
            ? new Response("", { status: 302, headers: { location: "http://inner.test/b" } })
            : ok("secret", "text/plain");
        },
      }),
    /resolves to/,
  );
  assert.deepEqual(reached, ["https://safe.test/a"], "the private hop is never requested");
});

/* ----------------------------------------------- redirects, hop by hop */

test("a redirect chain is re-checked at every hop, and the blocked hop is never fetched", async () => {
  const hops = [];
  const chain = {
    "https://x.test/1": { status: 302, location: "https://y.test/2" },
    "https://y.test/2": { status: 307, location: "http://10.0.0.5/admin" },
  };
  await assert.rejects(
    () =>
      webFetch("https://x.test/1", {
        fetch: async (url) => {
          hops.push(url);
          const hop = chain[url];
          if (hop) return new Response("", { status: hop.status, headers: { location: hop.location } });
          return ok("internal secrets", "text/plain");
        },
      }),
    /private URLs are blocked/,
    "a chain that ENDS private is as dangerous as one that starts private",
  );
  assert.deepEqual(hops, ["https://x.test/1", "https://y.test/2"], "the private hop is never requested");
});

test("a redirect may not change to a scheme the guard does not cover", async () => {
  const to = (location) =>
    webFetch("https://x.test/a", { fetch: async () => new Response("", { status: 302, headers: { location } }) });

  await assert.rejects(() => to("file:///etc/passwd"), /file: URLs are blocked/);
  await assert.rejects(() => to("data:text/html,pwned"), /only http\/https/);
  await assert.rejects(() => to("javascript:alert(1)"), /only http\/https/);
  await assert.rejects(() => to("ftp://example.com/x"), /only http\/https/);
  // Protocol-relative: it inherits https from the current hop, so the host is
  // all that is left to check — and it is loopback.
  await assert.rejects(() => to("//127.0.0.1/x"), /localhost URLs are blocked/);
  await assert.rejects(() => to("https://user:pw@evil.test/"), /credentials/);

  // https -> http IS allowed. Downgrading is a real thing public sites do, and
  // the guard's job is the host, not the transport.
  const downgraded = await webFetch("https://x.test/a", {
    fetch: async (url) =>
      url === "https://x.test/a"
        ? new Response("", { status: 301, headers: { location: "http://plain.test/ok" } })
        : ok("downgraded", "text/plain"),
  });
  assert.equal(downgraded.finalUrl, "http://plain.test/ok");
  assert.match(downgraded.text, /downgraded/);
});

// A server that answers `Location: http://` used to take webFetch out through
// `new URL(loc, current)` as a raw TypeError("Invalid URL") — a shape no caller
// branches on, from a code path that is entirely under a remote server's
// control.
test("a redirect to an unparseable location fails like every other bad hop", async () => {
  for (const location of ["http://", "https://", "http://%", "https://[::1"]) {
    const err = await webFetch("https://x.test/a", {
      fetch: async () => new Response("", { status: 302, headers: { location } }),
    }).then(() => null, (e) => e);
    assert.ok(err, `Location: ${location} must fail`);
    assert.equal(err.constructor.name, "Error", `Location: ${location} threw a ${err.constructor.name}`);
    assert.match(err.message, /redirect to an invalid url/, `Location: ${location}`);
  }
});

test("the redirect budget is hops, not requests, and zero is a legal budget", async () => {
  let requests = 0;
  const spin = async () => {
    requests += 1;
    return new Response("", { status: 308, headers: { location: "https://x.test/next" } });
  };
  // Default MAX_REDIRECTS is 5: six requests get made, then it gives up.
  await assert.rejects(() => webFetch("https://x.test/a", { fetch: spin }), /too many redirects/);
  assert.equal(requests, 6, "5 redirects means 6 requests");

  // maxRedirects:0 still makes the first request — it just may not follow.
  requests = 0;
  await assert.rejects(() => webFetch("https://x.test/a", { maxRedirects: 0, fetch: spin }), /too many redirects/);
  assert.equal(requests, 1);
  const direct = await webFetch("https://x.test/a", { maxRedirects: 0, fetch: async () => ok("here", "text/plain") });
  assert.match(direct.text, /here/, "a budget of zero is not a budget of none");

  // A negative budget is nonsense, so it falls back to the default rather than
  // refusing every URL.
  requests = 0;
  await assert.rejects(() => webFetch("https://x.test/a", { maxRedirects: -1, fetch: spin }), /too many redirects/);
  assert.equal(requests, 6);
});

test("every hop is a manual GET with its own abort signal", async () => {
  // `redirect: "manual"` is load-bearing: on "follow" the runtime chases the
  // Location header itself and assertPublicHttpUrl never sees the final host.
  const inits = [];
  const result = await webFetch("https://x.test/a", {
    fetch: async (url, init) => {
      inits.push(init);
      if (init.signal.aborted) throw new Error("signal arrived already aborted");
      return url.endsWith("/a")
        ? new Response("", { status: 303, headers: { location: "https://x.test/b" } })
        : ok("landed", "text/plain");
    },
  });
  assert.match(result.text, /landed/);
  assert.equal(inits.length, 2);
  for (const init of inits) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual", "the runtime must never follow a redirect past the guard");
    assert.ok(init.signal instanceof AbortSignal);
  }
  // A fresh controller per hop: otherwise hop 2 inherits hop 1's elapsed
  // deadline and a slow first hop times out the rest of the chain.
  assert.equal(new Set(inits.map((i) => i.signal)).size, 2, "each hop gets its own signal");
});

// The stub below settles ONLY when the signal fires, so the per-test timeout is
// part of the assertion: without it, a webFetch that never aborts would hang
// this file instead of failing it.
test("the timeout really aborts the request, it is not just a reported name", { timeout: 5_000 }, async () => {
  // The stub settles ONLY when the signal fires, so this passes only if
  // webFetch actually wires a timer to the AbortController it hands out.
  await assert.rejects(
    () =>
      webFetch("https://x.test/hang", {
        timeoutMs: 1,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      }),
    /web_fetch failed \(timeout\)/,
  );
});

/* ------------------------------------------------------- hostile bodies */

// `&#x110000;` is above the Unicode maximum, so String.fromCodePoint throws
// RangeError. The URL is chosen by the MODEL, so any page — hostile or merely
// broken — could take web_fetch out with an uncaught RangeError instead of a
// "web_fetch failed" the caller can report.
test("a numeric character reference outside Unicode does not take the fetch down", async () => {
  assert.equal(htmlToMarkdown("<p>&#x110000;</p>"), "", "hex past U+10FFFF is dropped");
  assert.equal(htmlToMarkdown("<p>&#1114112;</p>"), "", "and so is the decimal spelling");
  assert.equal(htmlToMarkdown("<p>&#99999999999999999999;</p>"), "");
  assert.equal(htmlToMarkdown("<p>&#xFFFFFFFFFFFFFFFF;</p>"), "");
  // ...while everything inside the range still decodes, including astral planes
  // and the entity that sits exactly on the boundary.
  assert.equal(htmlToMarkdown("<p>&#x1F6EB;&#x10FFFF;&#0;A</p>"), "\u{1F6EB}\u{10FFFF}\u{0}A");
  // A lone surrogate is a legal code point for fromCodePoint; it must not throw
  // either, and it must not corrupt the text around it.
  assert.match(htmlToMarkdown("<p>before&#xD800;after</p>"), /^before.?after$/u);
  // And the whole thing through the tool, since <title> decodes entities too.
  const page = await webFetch("https://x.test/hostile", {
    fetch: async () => ok("<html><head><title>&#x110000;Docs</title></head><body><p>&#x110000;ok</p></body></html>", "text/html"),
  });
  assert.match(page.text, /# Docs\n\nok$/);
});

test("an empty page still names its source, and a non-HTML body is passed through", async () => {
  // "" would look to a caller like the fetch produced nothing at all.
  const empty = await webFetch("https://x.test/nothing", { fetch: async () => ok("", "text/html") });
  assert.equal(empty.text, "Source: https://x.test/nothing");
  assert.equal(empty.status, 200);
  assert.equal(empty.contentType, "text/html");

  const blank = await webFetch("https://x.test/blank", { fetch: async () => ok("   \n\t  ", "text/plain") });
  assert.equal(blank.text, "Source: https://x.test/blank");

  // A content-type the extractor has no opinion about is handed over verbatim,
  // not run through the HTML stripper.
  const csv = await webFetch("https://x.test/data.csv", { fetch: async () => ok("a,b\n<1>,<2>\n", "text/csv") });
  assert.equal(csv.text, "Source: https://x.test/data.csv\n\na,b\n<1>,<2>");
});

test("bytes that are not UTF-8 come back as text, not as a throw", async () => {
  // A PDF, a JPEG, a gzip the server mislabelled: the model asked for a URL and
  // has to be told what is there, so this may degrade but may not fail.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0x81]);
  const res = await webFetch("https://x.test/photo.jpg", {
    fetch: async () => new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /^Source: https:\/\/x\.test\/photo\.jpg\n\n/);
  assert.match(res.text, /JFIF/, "the readable part survives");
  assert.match(res.text, /�/, "and the unreadable part becomes replacement characters");
});

test("the size cap counts bytes, and cutting a character mid-sequence is not fatal", async () => {
  // The cap is applied to the buffer, so a multi-byte character straddling the
  // boundary loses its tail. That is acceptable; throwing, or silently
  // returning the whole megabyte, are not.
  const body = "é".repeat(200); // 2 bytes each
  const cut = await webFetch("https://x.test/accents", {
    maxBytes: 51,
    fetch: async () => ok(body, "text/plain"),
  });
  assert.match(cut.text, /\[truncated\]$/);
  assert.equal(cut.text.startsWith("Source: https://x.test/accents\n\n" + "é".repeat(25)), true);
  assert.ok(Buffer.byteLength(cut.text.replace(/\n\n\[truncated\]$/, ""), "utf8") <= 51 + 40, "the byte cap held");

  // maxBytes:0 is not "no bytes" — it is unset, and falls back to the default.
  const zero = await webFetch("https://x.test/small", { maxBytes: 0, fetch: async () => ok("all of it", "text/plain") });
  assert.match(zero.text, /all of it$/);
  assert.equal(zero.text.includes("[truncated]"), false);
});

// DEFECT, reported not fixed: script/style/noscript are removed by a regex that
// requires the closing tag, so an UNCLOSED <script> leaves its source in the
// markdown handed to the model. This is not exotic — the 750KB byte cap cuts
// pages at an arbitrary offset, so any page longer than the cap whose tail is a
// script arrives here unterminated. Making the match run to end-of-input is
// what a browser does for <script>, but it would also let one stray "<style>"
// swallow the rest of a page, so it is a product call rather than a regex tweak.
test("an unterminated script does not leak its source into the page", () => {
  assert.equal(htmlToMarkdown('<p>hi</p><script>var apiKey = "s3cr3t"; alert(1)').includes("s3cr3t"), false);
  assert.equal(htmlToMarkdown("<p>hi</p><style>body{color:red}").includes("color:red"), false);
});

/* --------------------------------------------------------- failure paths */

test("a response with no usable status is a network failure, not a page", async () => {
  // `Number(res?.status) || 0` — a stub, a proxy, or a runtime that resolves
  // with something unexpected must not be read as a successful fetch.
  for (const res of [{}, { status: 0 }, { status: "ok" }, { status: null }, undefined]) {
    await assert.rejects(
      () => webFetch("https://x.test/x", { fetch: async () => res }),
      /web_fetch failed \(network\)/,
      `${JSON.stringify(res) ?? "undefined"} must not read as a page`,
    );
  }
  await assert.rejects(
    () => webFetch("https://x.test/x", { fetch: async () => new Response("upstream is down", { status: 503 }) }),
    /web_fetch failed \(503\)/,
  );
  // A thrown non-Error still produces a message rather than "[object Object]"
  // with no cause.
  await assert.rejects(
    () => webFetch("https://x.test/x", { fetch: async () => { throw "ECONNREFUSED 127.0.0.1:443"; } }),
    /web_fetch failed: ECONNREFUSED/,
  );
});

test("the guard runs before anything is fetched, and a missing fetch says so", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return ok("", "text/plain");
  };
  for (const url of ["http://127.0.0.1/", "file:///etc/passwd", "", "not a url"]) {
    await assert.rejects(() => webFetch(url, { fetch: spy }), /blocked|required|invalid url/);
  }
  assert.equal(called, false, "a refused URL must never reach the network");

  await assert.rejects(() => webFetch("https://x.test/x", { fetch: 42 }), /fetch is not available/);
});
