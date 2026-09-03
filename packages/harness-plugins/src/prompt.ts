import type { HarnessPlugin } from "./types.js";

/**
 * The per-turn note that tells the model which plugins its harness has
 * connected right now, so it reaches a service through its plugin before
 * opening a browser. Empty when there is nothing to say, so callers can
 * append it unconditionally.
 */
export function pluginsPromptBlock(plugins: HarnessPlugin[], opts: { settingsPath?: string | undefined } = {}): string {
  const list = Array.isArray(plugins) ? plugins : [];
  if (!list.length) return "";
  const where = opts.settingsPath || "Settings → Plugins";
  const on = list.filter((p) => p.status === "connected").map((p) => p.name);
  const off = list.filter((p) => p.status !== "connected").map((p) => p.name);
  const lines = ["## Plugins on this harness"];
  if (on.length) {
    lines.push(
      `Connected now: ${on.join(", ")}. For any of these services use that plugin's tools directly (they appear as mcp__… tools) BEFORE opening a browser or searching the web — it is structured, already signed in, and what the user connected it for.`,
    );
  } else {
    lines.push("None connected right now.");
  }
  if (off.length) {
    lines.push(
      `Available but not connected: ${off.join(", ")}. If a task needs one, say so and point the user to ${where} → Connect; do not paste connect links, and do not reach that service through the browser as a workaround unless they ask.`,
    );
  }
  return lines.join("\n");
}
