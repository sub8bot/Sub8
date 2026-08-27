import type { AgentId, GroupJson } from "./types.js";

export const AGENT_DATA_ROOT = "/config/agent-data";

export function agentDir(id: AgentId): string {
  return `${AGENT_DATA_ROOT}/agents/${id}`;
}

/** A channel is an agent folder that has `group.json`. */
export function isChannel(dirListing: { groupJson?: GroupJson }): boolean {
  return dirListing?.groupJson != null;
}
