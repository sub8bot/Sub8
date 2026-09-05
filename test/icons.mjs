import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as icons from "../web/icons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(root, "web", "app.js"), "utf8");

const names = Object.keys(icons).sort();
assert.equal(names.length, 23, `expected 22 glyphs, found ${names.length}`);

for (const name of names) {
  const fn = icons[name];
  assert.equal(typeof fn, "function", `${name} must be a function`);
  assert.equal(fn.length, 0, `${name} takes no arguments — size and colour come from the call site`);
  const svg = fn();
  assert.equal(typeof svg, "string", `${name} must return a string`);
  assert.ok(svg.startsWith("<svg "), `${name} must return an <svg> element`);
  assert.ok(svg.endsWith("</svg>"), `${name} must close its <svg>`);
  assert.ok(!svg.includes("\n"), `${name} must stay a single line`);
  assert.match(svg, /viewBox="0 0 24 24"/, `${name} must draw on the shared 24x24 grid`);
  assert.match(svg, /width="\d+" height="\d+"/, `${name} must carry an explicit size`);
  // A glyph either inherits the surrounding text colour or commits to one.
  assert.ok(
    svg.includes("currentColor") || /(?:fill|stroke)="#[0-9a-f]{3,8}"/i.test(svg),
    `${name} must use currentColor or an explicit colour`,
  );
  // Calling twice must give the same string — these are pure, not stateful.
  assert.equal(fn(), svg, `${name} must be pure`);
}

// The glyphs left app.js for good; a stray copy would silently shadow the import.
assert.doesNotMatch(app, /^function icon[A-Za-z0-9]*\(\)/m, "icon glyphs live in web/icons.mjs now");

// Every glyph app.js calls must actually be imported, and nothing unused imported.
const called = new Set([...app.matchAll(/\bicon[A-Z][A-Za-z0-9]*(?=\()/g)].map((m) => m[0]));
const importLine = app.match(/^import \{([^}]*)\} from "\.\/icons\.mjs";$/m);
assert.ok(importLine, "app.js must import from ./icons.mjs");
const imported = importLine[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
assert.deepEqual(imported, names, "app.js imports must match the module's exports exactly");
for (const name of called) {
  assert.ok(imported.includes(name), `app.js calls ${name}() but does not import it`);
}
for (const name of imported) {
  assert.ok(called.has(name), `app.js imports ${name} but never calls it`);
}

console.log("ok icons");
