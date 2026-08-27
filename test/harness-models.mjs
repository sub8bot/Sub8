import assert from "node:assert/strict";
import { listModelsForProvider, modelFieldKind, pickListedModel } from "../web/harness-models.mjs";

const hermes = listModelsForProvider("hermes", {
  hermesCurrent: "qwen3.6-27b",
  lmstudio: ["local-qwen"],
});
assert.ok(hermes.includes("qwen3.6-27b"));
assert.ok(hermes.includes("local-qwen"));
assert.ok(hermes.includes("qwen3.8-27b"));
assert.equal(modelFieldKind("hermes", hermes), "select");
assert.equal(pickListedModel("hermes", "", hermes), "qwen3.6-27b");
assert.equal(pickListedModel("hermes", "local-qwen", hermes), "local-qwen");

assert.equal(modelFieldKind("grok-build", ["grok-4.6", "grok-4.5"]), "select");
assert.equal(modelFieldKind("claude", []), "cli");
assert.equal(modelFieldKind("codex", []), "cli");
assert.equal(modelFieldKind("ollama", []), "detect");
const codex = listModelsForProvider("codex", { codexCurrent: "gpt-5.6-sol", codex: ["gpt-5.6-terra"] });
assert.equal(codex[0], "gpt-5.6-sol");
assert.ok(codex.includes("gpt-5.6-terra"));
assert.ok(codex.includes("gpt-5.6-luna"));
assert.equal(modelFieldKind("codex", codex), "select");
const codexFallback = listModelsForProvider("codex", {});
assert.ok(codexFallback.length > 0, "Codex always has fallback models");
assert.equal(modelFieldKind("codex", codexFallback), "select");
assert.equal(modelFieldKind("default", []), "app-default");
const cursor = listModelsForProvider("cursor", { cursorCurrent: "auto", cursor: ["composer-2.5"] });
assert.equal(cursor[0], "auto");
assert.ok(cursor.includes("composer-2.5"));
assert.ok(cursor.includes("cursor-grok-4.6-low"));
assert.equal(modelFieldKind("cursor", cursor), "select");
assert.equal(pickListedModel("cursor", "", cursor), "cursor-grok-4.6-low");
assert.equal(pickListedModel("cursor", "auto", cursor), "auto");
assert.equal(pickListedModel("cursor", "", []), "cursor-grok-4.6-low");
assert.equal(modelFieldKind("cursor", []), "cli");
const hermesEmptyCatalog = listModelsForProvider("hermes", {});
assert.ok(hermesEmptyCatalog.length > 0, "Hermes always has fallback models");
assert.equal(modelFieldKind("hermes", hermesEmptyCatalog), "select");

console.log("ok harness-models");
