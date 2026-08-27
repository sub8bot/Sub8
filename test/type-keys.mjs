import assert from "node:assert/strict";
import { looksLikeTypedText } from "../server/vm.mjs";

assert.equal(looksLikeTypedText("ctrl+l"), false);
assert.equal(looksLikeTypedText("Return"), false);
assert.equal(looksLikeTypedText("Escape"), false);
assert.equal(looksLikeTypedText("super+d"), false);
assert.equal(looksLikeTypedText("ctrl+shift+t"), false);
assert.equal(
  looksLikeTypedText("https://www.kayak.com/flights/SFO-WAS/2026-08-21?sort=price"),
  true,
);
assert.equal(looksLikeTypedText("httpswwwkayakcomflights"), false);
assert.equal(looksLikeTypedText("hello world"), true);
assert.equal(looksLikeTypedText("/"), true);
assert.equal(looksLikeTypedText("a"), false);

console.log("ok type-keys");
