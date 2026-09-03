import type { HarnessPlugin } from "./types.js";

/** The reason the harness gave, without its glyph/prefix, short enough for a prompt line. */
export function shortDetail(detail: string | undefined, max = 90): string {
  const d = String(detail || "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/^failed to connect\s*[—-]+\s*/i, "")
    // A leading JSON-RPC code ("-32429: ") is noise for a person or a bot.
    .replace(/^-?\d{3,6}:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return d.length > max ? `${d.slice(0, max - 1)}…` : d;
}

/**
 * The per-turn note that tells the model which plugins its harness has
 * connected right now, so it reaches a service through its plugin before
 * opening a browser. Not-connected plugins are split into "needs sign-in"
 * (the user must connect it) and "temporarily unavailable" (a probe failed —
 * rate limit, timeout — and may recover), with the harness's own reason, so
 * what the bot says matches what Settings shows. Empty when there is nothing
 * to say, so callers can append it unconditionally.
 */
export function pluginsPromptBlock(plugins: HarnessPlugin[], opts: { settingsPath?: string | undefined } = {}): string {
  const list = Array.isArray(plugins) ? plugins : [];
  if (!list.length) return "";
  const where = opts.settingsPath || "Settings → Plugins";
  const on = list.filter((p) => p.status === "connected").map((p) => p.name);
  const auth = list.filter((p) => p.status === "needs_auth").map((p) => p.name);
  const down = list
    .filter((p) => p.status !== "connected" && p.status !== "needs_auth")
    .map((p) => (shortDetail(p.detail) ? `${p.name} (${shortDetail(p.detail)})` : p.name));
  const lines = ["## Plugins on this harness"];
  if (on.length) {
    lines.push(
      `Connected now: ${on.join(", ")}. For any of these services use that plugin's tools directly (they appear as mcp__… tools) BEFORE opening a browser or searching the web — it is structured, already signed in, and what the user connected it for.`,
    );
  } else {
    lines.push("None connected right now.");
  }
  if (auth.length) {
    lines.push(
      `Not connected (needs sign-in): ${auth.join(", ")}. If a task needs one, say so and point the user to ${where} → Connect; do not paste connect links, and do not reach that service through the browser as a workaround unless they ask.`,
    );
  }
  if (down.length) {
    lines.push(
      `Temporarily unavailable (a check failed; may recover on retry): ${down.join("; ")}. Try its tool once; if it still fails, say it is unavailable right now rather than switching to the browser.`,
    );
  }
  return lines.join("\n");
}
