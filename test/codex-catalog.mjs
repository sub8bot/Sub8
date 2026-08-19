import assert from "node:assert/strict";
import { parseCodexModelCatalog } from "../server/harness-status.mjs";

const catalog = {
  models: [
    { slug: "gpt-5.6-sol", visibility: "list", priority: 1 },
    { slug: "gpt-5.6-terra", visibility: "list", priority: 2 },
    { slug: "codex-auto-review", visibility: "hide", priority: 43 },
    { slug: "gpt-5.4", visibility: "hide", priority: 16 },
  ],
};

const slugs = parseCodexModelCatalog(catalog, { current: "gpt-5.6-sol" });
assert.deepEqual(slugs, ["gpt-5.6-sol", "gpt-5.6-terra"]);
assert.equal(slugs.includes("codex-auto-review"), false);

const withCurrent = parseCodexModelCatalog(catalog, { current: "gpt-5.4-mini" });
assert.equal(withCurrent[0], "gpt-5.4-mini");
assert.ok(withCurrent.includes("gpt-5.6-sol"));

console.log("ok codex-catalog");
