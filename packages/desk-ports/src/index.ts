export type { ConnectRemote, HarnessRemote, PortMap } from "./types.js";

/**
 * One definition of the in-desk harness port. `server/vm.mjs` and
 * `server/desk-client.mjs` each used to declare their own
 * `DESK_HARNESS_CONTAINER_PORT = 3011`.
 */
export { HARNESS_PORT } from "@sub8/harness-protocol";

export {
  DISPLAY_SLOTS,
  HARNESS_STDIO_BRIDGE,
  harnessHostPort,
  mappedHarnessPort,
  needsHarnessPublish,
  parseDisplayPorts,
  resolveStreamPort,
  streamPortForDisplay,
} from "./ports.js";

export { attachHarnessProxy } from "./proxy.js";

export { PACK_MAX_SLOTS, PACK_PORT_BASE, PACK_SLOT_STRIDE, packedPort } from "./ports.js";
