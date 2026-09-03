/**
 * Claude harness plugins. Claude Code lists its MCP servers/connectors with
 * `claude mcp list`, and that output already carries each one's connection
 * status, so this provider is a pure parser over it plus the place to send
 * the user to connect one that is not.
 */

import type { HarnessExec, HarnessPlugin, HarnessPluginProvider, PluginConnStatus } from "./types.js";

/**
 * Where a claude.ai connector is connected/authorized. Connectors live under
 * Customize now; the old /settings/connectors page is only a "moved" notice,
 * so link straight to the list.
 */
export const CLAUDE_CONNECTORS_PAGE = "https://claude.ai/new#settings/customize-connectors";

/** A stable, url-safe id from a plugin's full reported name. */
export function pluginSlug(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize the status column of `claude mcp list` into one of four states. */
export function claudeStatus(raw: string): PluginConnStatus {
  const s = String(raw || "").toLowerCase();
  if (/connected|✔|✓/.test(s)) return "connected";
  if (/needs? auth|authentication|not authenticated|sign in|log in|^\s*!/.test(s)) return "needs_auth";
  if (/fail|error|unreachable|timed out|could not|✗|✘/.test(s)) return "error";
  return "unknown";
}

/**
 * Friendlier label: drop the "claude.ai " connector prefix and the
 * "plugin:<pkg>:" prefix a marketplace plugin's server carries.
 */
export function claudeDisplayName(name: string): string {
  const cleaned = String(name || "")
    .replace(/^claude\.ai\s+/i, "")
    .replace(/^plugin:[^:]+:/i, "")
    .trim();
  return cleaned || String(name || "").trim();
}

/**
 * Parse `claude mcp list`. Each server prints as one line:
 *   <name>: <url> [(<transport>)] - <status>
 * A name can itself contain colons (e.g. "plugin:stripe:stripe"), so the
 * name/url split is the ": " that immediately precedes the http(s) URL, not
 * the first colon. Header lines and blanks do not match and are skipped.
 */
export function parseClaudeMcpList(out: string): HarnessPlugin[] {
  const plugins: HarnessPlugin[] = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const m = line.match(/^(.*?):\s+(https?:\/\/\S+?)(?:\s+\(([^)]+)\))?\s+-\s+(.*)$/);
    if (!m) continue;
    const fullName = String(m[1] || "").trim();
    if (!fullName) continue;
    const statusText = String(m[4] || "").trim();
    plugins.push({
      id: pluginSlug(fullName),
      name: claudeDisplayName(fullName),
      harness: "claude",
      url: String(m[2] || "").trim(),
      transport: m[3] ? String(m[3]).trim() : undefined,
      status: claudeStatus(statusText),
      detail: statusText,
    });
  }
  return plugins;
}

export const claudePlugins: HarnessPluginProvider = {
  harness: "claude",
  label: "Claude",

  async listPlugins(exec: HarnessExec): Promise<HarnessPlugin[]> {
    // `claude mcp list` probes every server's health, so it can take a while;
    // give it room rather than reporting a healthy connector as unknown.
    const { stdout } = await exec.run("claude", ["mcp", "list"], { timeoutMs: 45_000 });
    const plugins = parseClaudeMcpList(stdout);
    for (const p of plugins) {
      if (p.status !== "connected") p.connectUrl = CLAUDE_CONNECTORS_PAGE;
    }
    return plugins;
  },

  connectUrl(plugin: HarnessPlugin): string | null {
    return plugin.connectUrl || CLAUDE_CONNECTORS_PAGE;
  },
};
