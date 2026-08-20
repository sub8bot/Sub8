/**
 * Two tunnels, hard rule:
 *  - outside: computer-use (screenshot / mouse / keys) against the VM display
 *  - inside:  shell + grok harness, only as docker exec into that VM
 * Never the host Mac.
 */

export function requireVm(bot, op = "action") {
  const name = bot?.vm?.container;
  if (!name || !String(name).startsWith("localbot-")) {
    throw new Error(`${op} blocked: no bot computer. Work only happens inside the VM.`);
  }
  return name;
}

export function isHostPath(p) {
  const s = String(p || "");
  return (
    s.includes("/Users/") ||
    s.startsWith("/Users") ||
    s.includes("/home/dan") ||
    s.includes("/Library/") ||
    s.includes("/Applications/")
  );
}

export function assertVmShell(command) {
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
    /\b(cat|sqlite|python|cp|dd|hexdump|strings)\b/i.test(c) &&
    /(Cookies|Login Data|\/\.secrets\b|chrome-desk\/Default\/Cookies)/i.test(c)
  ) {
    throw new Error("shell blocked: do not dump cookies or secrets.");
  }
}
