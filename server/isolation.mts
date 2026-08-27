/**
 * Two tunnels, hard rule:
 *  - outside: computer-use (screenshot / mouse / keys) against the VM display
 *  - inside:  shell + grok harness, only as docker exec into that VM
 * Never the host Mac.
 */

/**
 * The shape these guards actually read off a bot. Deliberately minimal and
 * structural: callers pass the full bot record, which is far wider than this
 * and still untyped at most call sites.
 */
export interface IsolationBot {
  vm?:
    | {
        deskUrl?: string | undefined;
        deskToken?: string | undefined;
        container?: string | undefined;
      }
    | undefined;
}

export function requireVm(bot: IsolationBot | null | undefined, op = "action"): string {
  if (bot?.vm?.deskUrl && bot?.vm?.deskToken) return bot.vm.container || "sub8-desk";
  const name = bot?.vm?.container;
  if (!name || !String(name).startsWith("localbot-")) {
    throw new Error(`${op} blocked: no bot computer. Work only happens inside the VM.`);
  }
  return name;
}

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
    // sqlite3 / python3 are the real binary names, and \bsqlite\b does NOT match
    // "sqlite3" — the trailing digit kills the word boundary. So the versionless
    // spellings were blocked while the ones anyone would actually type were not.
    // @sub8/constants carries this same rule for callers that can resolve a
    // package. This file deliberately does NOT import it: server/vm.mjs does
    // `docker cp server/isolation.mjs <container>:/usr/local/lib/sub8/` and the
    // copy runs with no node_modules beside it, so an import would break the
    // guard inside the container. test/isolation.mjs pins the two in sync.
    /\b(cat|sqlite\d*|python\d*|cp|dd|hexdump|strings)\b/i.test(c) &&
    /(Cookies|Login Data|\/\.secrets\b|chrome-desk\/Default\/Cookies)/i.test(c)
  ) {
    throw new Error("shell blocked: do not dump cookies or secrets.");
  }
}
