import assert from "node:assert/strict";
import { resolveReadPath } from "../../../server/read-file.mjs";
import { assertPublicHttpUrl } from "@sub8/web-fetch";
import { assertCodeAgentCwd } from "../../../packages/orchestration/dist/index.js";

/** Isolation: no host Mac paths, no file:/localhost fetch, code-agent cwd under /config. */
export async function run() {
  assert.throws(() => resolveReadPath("/Users/someone/secret"), /must be under/);
  assert.throws(() => resolveReadPath("/Users"), /must be under/);
  assert.throws(() => resolveReadPath("/config/../Users/someone/secret"), /must be under|invalid path/);
  assert.equal(resolveReadPath("/config/workspace/notes.md"), "/config/workspace/notes.md");

  assert.throws(() => assertCodeAgentCwd("/Users/someone/project"), /under \/config/);
  assert.equal(assertCodeAgentCwd("/config/workspace/app"), "/config/workspace/app");

  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /file:/);
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/"), /localhost|loopback|blocked/i);
  assert.throws(() => assertPublicHttpUrl("http://localhost:3011/turn"), /localhost|loopback|blocked/i);
  const ok = assertPublicHttpUrl("https://example.com/doc");
  assert.equal(ok.hostname, "example.com");
}
