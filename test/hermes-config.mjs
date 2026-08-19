import assert from "node:assert/strict";
import { HERMES_SUB8_CTX, withHermesContextLength, withHermesReasoningEffort } from "../server/host-cli.mjs";

const slim = withHermesReasoningEffort(withHermesContextLength("model:\n  default: qwen3.8-27b\n", HERMES_SUB8_CTX), "low");
assert.match(slim, /context_length:\s*65536/);
assert.match(slim, /reasoning_effort:\s*low/);

const host = withHermesContextLength("model:\n  context_length: 4096\n  default: x\n");
assert.match(host, /context_length:\s*131072/);

const swapped = withHermesReasoningEffort("agent:\n  reasoning_effort: medium\n  verbose: false\n", "low");
assert.match(swapped, /reasoning_effort:\s*low/);
assert.match(swapped, /verbose: false/);
console.log("ok hermes-config");
