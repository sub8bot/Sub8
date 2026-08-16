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
}
