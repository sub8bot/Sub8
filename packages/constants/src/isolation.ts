/**
 * Two tunnels, hard rule:
 *  - outside: computer-use (screenshot / mouse / keys) against the VM display
 *  - inside:  shell + grok harness, only as docker exec into that VM
 * Never the host Mac.
 *
 * These are pure guards with no I/O, which is why they are the first thing to
 * move: every caller in `server/` imports them for their throw behaviour alone.
 */

/** Minimal shape these guards need; the real bot record carries much more. */
export interface VmBotLike {
  vm?: {
    container?: string | undefined;
    deskUrl?: string | undefined;
    deskToken?: string | undefined;
  };
}

/** Resolve the container an operation may touch, or throw. */
export function requireVm(bot: VmBotLike | null | undefined, op = "action"): string {
  if (bot?.vm?.deskUrl && bot?.vm?.deskToken) return bot.vm.container || "sub8-desk";
  const name = bot?.vm?.container;
  if (!name || !String(name).startsWith("localbot-")) {
    throw new Error(`${op} blocked: no bot computer. Work only happens inside the VM.`);
  }
  return name;
}

/** True when a path points at the host Mac rather than inside the desk. */
export function isHostPath(p: unknown): boolean {
  const s = String(p || "");
  return (
    s.includes("/Users/") ||
    s.startsWith("/Users") ||
    s.includes("/home/") ||
    s.includes("/Library/") ||
    s.includes("/Applications/")
  );
}

/**
 * Reject shell commands that escape the desk: host paths, synthetic input
 * (which must go through the computer tool so it lands on the right display),
 * Chrome's debug port, and cookie/secret dumping.
 */
export function assertVmShell(command: unknown): void {
  const c = String(command || "");
  if (isHostPath(c) || /\bcd\s+\/Users\b/.test(c)) {
    throw new Error("shell blocked: host paths are not visible to the bot.");
  }
  if (/\b(xdotool|xte|ydotool)\b/i.test(c) || /\b(octo-click|box-input)\b/i.test(c)) {
    throw new Error("shell blocked: do not click or type from the shell. Use the computer tool.");
  }
  if (
    /\b(playwright|puppeteer|websocket-client)\b/i.test(c) ||
    /127\.0\.0\.1:9222|:9222\/json|\/json\/new|\/json\/close|webSocketDebuggerUrl|Runtime\.evaluate/i.test(c)
  ) {
    throw new Error("shell blocked: do not attach to Chrome's debug port. Use computer action open.");
  }
  if (
    // sqlite3 / python3 are the real binary names, and \bsqlite\b does NOT
    // match "sqlite3" — the trailing digit kills the word boundary, which is
    // how the versionless spellings got blocked while the ones anyone would
    // actually type walked through. server/isolation.mts carries an identical
    // copy (it ships into containers standalone and cannot import this), and
    // test/isolation.mjs fails if the two ever diverge.
    /\b(cat|sqlite\d*|python\d*|cp|dd|hexdump|strings)\b/i.test(c) &&
    /(Cookies|Login Data|\/\.secrets\b|chrome-desk\/Default\/Cookies)/i.test(c)
  ) {
    throw new Error("shell blocked: do not dump cookies or secrets.");
  }
}
