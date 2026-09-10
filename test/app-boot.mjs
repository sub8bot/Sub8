import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// This file reads two spellings of the same program on purpose.
//
//   src  = web/app.ts, the hand-written source.
//   app  = web/app.js, what tsc emits from it and what index.html loads.
//
// The split follows what each assertion is actually pinning. Assertions about
// how the source is WRITTEN — a template that must interpolate skus.map rather
// than ${skus} then .map, an init() that is wrapped in a catch, a paintRail that
// bails on a missing #rail — belong against the source, because tsc reformats
// its own output (it re-indents to four spaces, puts `else`/`catch` and a
// single-statement `if` body on their own lines, and drops a trailing comma when
// it re-wraps an argument list). Asserting that shape on the emit would be
// asserting tsc's printer, not this codebase.
//
// Assertions about what SHIPS — that the file parses, that a given string or
// call is in the bundle the browser downloads — stay on the emit, because that
// is the artefact those claims are about.
const src = readFileSync(path.join(root, "web", "app.ts"), "utf8");
const app = readFileSync(path.join(root, "web", "app.js"), "utf8");
const html = readFileSync(path.join(root, "web", "index.html"), "utf8");

// The browser loads the emit, so the emit is what has to parse.
execFileSync(process.execPath, ["--check", path.join(root, "web", "app.js")]);

assert.doesNotMatch(
  src,
  /\$\{skus\}\s*\n\s*\.map\s*\(/,
  "cloudSkuPicksHtml must interpolate skus.map, not ${skus} then .map (that parse error whitescreens the app)",
);
assert.match(src, /\$\{skus\s*\n\s*\.map/);
assert.match(src, /\(async function init\(\) \{/);
assert.match(src, /catch \(err\) \{\s*\n\s*console\.error\("Sub8 init failed"/);
assert.match(app, /id="boot-error"/);
assert.match(src, /try \{\s*\n\s*refreshAvatars\(\);\s*\n\s*\} catch/);
// Same guard as before, now also pinning the signature it is annotated with.
assert.match(
  src,
  /function paintRail\(bot: Bot \| null \| undefined\): void \{\s*\n\s*const rail = \$\("#rail"\);\s*\n\s*if \(!rail\) return;/,
);

assert.match(html, /addEventListener\("error"/);
assert.match(html, /id="boot-error"|boot-error/);
assert.match(app, /mergeCloudDraft/);
// Cache-busting tags must be bumped together. A half-landed bump (new CSS tag,
// stale JS tag) ships some clients fresh styles against stale scripts, so assert
// every tagged asset on a page carries the SAME tag rather than pinning a
// literal version here — a hardcoded version only forces the next bump to edit
// this file, it doesn't stop the halves from drifting apart.
const pages = readdirSync(path.join(root, "web")).filter((f) => f.endsWith(".html"));
assert.ok(pages.includes("index.html"));
let taggedAssets = 0;
for (const page of pages) {
  const src = readFileSync(path.join(root, "web", page), "utf8");
  const tags = [...src.matchAll(/(?:href|src)="([^"]+)\?v=([^"&]+)"/g)].map((m) => ({
    asset: m[1],
    v: m[2],
  }));
  taggedAssets += tags.length;
  for (const t of tags) {
    assert.equal(
      t.v,
      tags[0].v,
      `web/${page}: cache tag mismatch — ${t.asset}?v=${t.v} vs ${tags[0].asset}?v=${tags[0].v}. ` +
        `Bump every ?v= on a page together or clients get mismatched assets.`,
    );
  }
}
// Guard the guard: if the tags ever disappear, the loop above would pass vacuously.
assert.ok(taggedAssets >= 3, `expected cache-busted assets in web/, found ${taggedAssets}`);
assert.match(html, /app\.js\?v=/);
assert.match(html, /styles\.css\?v=/);
assert.match(src, /state\.modal === "claude-code"/);
assert.match(src, /awaitingCode: true/);
assert.match(app, /data-act="send-choice"/);
// A behaviour claim, not a formatting one: the open card is held only while it
// is still pending. It reads that way in the emit; the source spells the same
// expression with a type assertion in front of focusedCard, so the emit is
// where this shape is legible.
assert.match(app, /focusedCard\?\.pending !== false/);
assert.match(app, /function typedChoiceAnswer\(/);

// onSend() reads e.target.q on its first line. submitChoice's Cloud branch
// synthesises the event, and it used to pass only { preventDefault() {} } — so
// picking a choice in the Cloud place threw "Cannot read properties of
// undefined (reading 'q')" and never sent. A behaviour claim about what ships,
// so it is asserted on the emit.
{
  const call = app.match(/await onSend\(\{([^}]*\}[^}]*)\}\)/);
  assert.ok(call, "could not find the synthesised onSend call");
  assert.match(call[1], /target:/, "the synthesised submit event must carry the form as its target");
}

// tsconfig.web.json and tsconfig.server.json both redirect declarationDir into
// node_modules/.cache, so tsc-emitted declarations never belong in these trees.
// One did appear — an ad-hoc `tsc --declaration` without --declarationDir wrote
// web/brain-setup.d.mts beside its own source. It matters because both projects
// include **/*.mts, so a stray declaration is compiled as a project INPUT next
// to the source it describes.
//
// The test is "sits beside a same-named source", not "is a .d.ts at all": a
// HAND-WRITTEN ambient declaration is legitimate source. server/express.d.ts is
// exactly that — express@5.2.1 ships no types and there is no @types/express,
// so it declares the slice this server uses and gives all 104 route handlers a
// contextual type. It has no express.mts beside it, so it is not emit.
{
  const emitted = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      const m = e.name.match(/^(.+)\.d\.(ts|mts)$/);
      if (!m) continue;
      // A sibling source of the same stem means tsc wrote this next to its input.
      const twins = [".ts", ".mts"].filter((ext) => existsSync(path.join(root, dir, m[1] + ext)));
      if (twins.length) emitted.push(`${rel} (beside ${m[1]}${twins[0]})`);
    }
  };
  ["web", "server"].forEach(walk);
  assert.deepEqual(emitted, [], `emitted declarations belong in node_modules/.cache, not the source tree: ${emitted.join(", ")}`);
}

// electron-builder only copies package.json `dependencies` into
// app.asar/node_modules. A workspace package that server/ or electron/
// import by name, but that is missing from that list, boots locally (npm
// workspaces hoist it) and whitescreens the shipped app with
// ERR_MODULE_NOT_FOUND — 0.3.37 died on @sub8/vault-crypto this way.
{
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const deps = new Set(Object.keys(pkg.dependencies || {}).filter((k) => k.startsWith("@sub8/")));
  const imported = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(mjs|js)$/.test(e.name)) continue;
      const src = readFileSync(path.join(root, rel), "utf8");
      for (const m of src.matchAll(/from\s+["'](@sub8\/[^"']+)["']/g)) {
        imported.add(m[1].split("/").slice(0, 2).join("/"));
      }
    }
  };
  walk("server");
  walk("electron");
  const missing = [...imported].filter((n) => !deps.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `electron-builder will not pack ${missing.join(", ")} into asar node_modules; the packaged app whitescreens`,
  );
}

{
  const main = readFileSync(path.join(root, "electron", "main.mts"), "utf8");
  assert.match(main, /Sub8 failed to start/, "packaged window must not stay white if the server never binds");
  assert.match(main, /waitForServer\(\)\.then\(\(up\)/, "do not loadURL in finally when the server is down");
}

console.log("ok app-boot");
