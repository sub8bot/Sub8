import assert from "node:assert/strict";
import { HERMES_SUB8_CTX, withHermesContextLength, withHermesHostLockdown, withHermesReasoningEffort } from "../server/host-cli.mjs";

const slim = withHermesReasoningEffort(withHermesContextLength("model:\n  default: qwen3.8-27b\n", HERMES_SUB8_CTX), "low");
assert.match(slim, /context_length:\s*65536/);
assert.match(slim, /reasoning_effort:\s*low/);

const host = withHermesContextLength("model:\n  context_length: 4096\n  default: x\n");
assert.match(host, /context_length:\s*131072/);

const swapped = withHermesReasoningEffort("agent:\n  reasoning_effort: medium\n  verbose: false\n", "low");
assert.match(swapped, /reasoning_effort:\s*low/);
assert.match(swapped, /verbose: false/);

const locked = withHermesHostLockdown(`toolsets:
- hermes-cli
agent:
  disabled_toolsets: []
  verbose: false
platform_toolsets:
  cli:
  - browser
  - terminal
  - web
  telegram:
  - hermes-telegram
browser:
  cloud_provider: local
`);
assert.match(locked, /toolsets: \[\]/);
assert.match(locked, /disabled_toolsets:\n  - browser\n  - terminal\n  - web/);
assert.match(locked, /cli: \[\]/);
assert.doesNotMatch(locked, /cli:\n  - browser/);
assert.match(locked, /cloud_provider: none/);
console.log("ok hermes-config");
