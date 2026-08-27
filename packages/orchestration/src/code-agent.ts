import path from "node:path";
import type { AgentId } from "./types.js";

export type CodeAgentId = string;
export type CodeAgentAction = "launch" | "list" | "get" | "reply" | "cancel" | "delete";

export interface CodeAgentSession {
  id: CodeAgentId;
  botId: AgentId;
  computerId: string;
  repoUrl?: string;
  cwd: string;
  status: "running" | "done" | "error" | "cancelled";
  prUrl?: string;
}

const CONFIG_ROOT = "/config";

/** Normalize `cwd` and throw if it is not under `/config`. */
export function assertCodeAgentCwd(cwd: string): string {
  const raw = String(cwd ?? "").trim();
  if (!raw.startsWith("/")) {
    throw new Error("cwd must be under /config");
  }
  const n = path.posix.normalize(raw);
  if (n !== CONFIG_ROOT && !n.startsWith(`${CONFIG_ROOT}/`)) {
    throw new Error("cwd must be under /config");
  }
  return n;
}
