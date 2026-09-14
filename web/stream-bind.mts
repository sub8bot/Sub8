/** The bot fields this file reads: the local VM and the desk it is streaming. */
export interface StreamBot {
  id?: string;
  vm?: { novncPort?: number; streamUrl?: string } | null;
}

export interface StreamDesk {
  id?: string;
  streamUrl?: string;
  status?: string;
}

export function frameKey(bot: StreamBot | null | undefined): string | null {
  if (!bot?.id || !bot?.vm?.novncPort) return null;
  return `${bot.id}:${bot.vm.novncPort}`;
}

export function cloudFrameKey(desk: StreamDesk | null | undefined): string {
  if (!desk?.id && !desk?.streamUrl) return "cloud:empty";
  return `cloud:${desk.id || ""}:${desk.streamUrl || ""}:${desk.status || ""}`;
}

/** noVNC shows the Connect splash unless autoconnect is in the query or hash. */
export function novncAutoconnectUrl(raw: string | null | undefined, { viewOnly = false }: { viewOnly?: boolean } = {}): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(s);
  let u: URL;
  try {
    u = relative ? new URL(s, "http://local.invalid") : new URL(s);
  } catch {
    return s;
  }
  if (!/vnc\.html$/i.test(u.pathname) && u.pathname !== "/") return s;
  u.searchParams.set("autoconnect", "true");
  u.searchParams.set("reconnect", "true");
  u.searchParams.set("reconnect_delay", "1500");
  u.searchParams.set("resize", "scale");
  if (viewOnly) u.searchParams.set("view_only", "true");
  else u.searchParams.delete("view_only");
  const hash = ["autoconnect=true", "reconnect=true", "resize=scale"];
  if (viewOnly) hash.push("view_only=true");
  u.hash = hash.join("&");
  return relative ? `${u.pathname}${u.search}${u.hash}` : u.toString();
}

/** Cached screenshot may cover the iframe only while VNC is not yet live. */
export function stillCoversLive({ streamReady = false }: { streamReady?: boolean } = {}): boolean {
  return !streamReady;
}

/**
 * Same-origin Cloud desk URL. The desktop app cannot load http://droplet:3000
 * (firewalled) or https://sub8.bot/api/desk (cross-site cookies). The local
 * server proxies both with the session Bearer token.
 */
export function desktopCloudStreamUrl(
  computerId: string | null | undefined,
  { display = 1 }: { display?: unknown } = {},
): string {
  const id = String(computerId || "").trim();
  if (!id) return "";
  const n = Number(String(display ?? "1").replace(/^:/, ""));
  const slot = Number.isFinite(n) && n > 1 ? n : 1;
  const encoded = encodeURIComponent(id);
  const wsPath =
    slot > 1
      ? `api/cloud/stream/${encoded}/websockify?display=${slot}`
      : `api/cloud/stream/${encoded}/websockify`;
  const q = new URLSearchParams({
    autoconnect: "true",
    reconnect: "true",
    reconnect_delay: "1500",
    resize: "scale",
    path: wsPath,
  });
  return `/api/cloud/stream/${encoded}/vnc.html?${q.toString()}#autoconnect=true&reconnect=true&resize=scale`;
}

/** Mount the cloud iframe once the desk is assigned and VNC answers, or after a short give-up. */
export function shouldMountCloudFrame({
  assigned = false,
  vncUp = false,
  waitedMs = 0,
  giveUpMs = 12000,
}: { assigned?: boolean; vncUp?: boolean; waitedMs?: number; giveUpMs?: number } = {}): boolean {
  if (!assigned) return false;
  return Boolean(vncUp) || Number(waitedMs) >= giveUpMs;
}

/** Remount only if we already had a frame while VNC was down, then it came up. */
export function shouldKickCloudFrame({ vncUp = false, hadFrame = false, wasUp = false }: { vncUp?: boolean; hadFrame?: boolean; wasUp?: boolean } = {}): boolean {
  return Boolean(vncUp && hadFrame && !wasUp);
}

export function applyHealthPort(
  bot: StreamBot | null | undefined,
  health: { novncPort?: number } | null | undefined,
): { bot: StreamBot | null | undefined; changed: boolean } {
  const port = health?.novncPort;
  if (!bot?.vm || !port || bot.vm.novncPort === port) return { bot, changed: false };
  return { bot: { ...bot, vm: { ...bot.vm, novncPort: port } }, changed: true };
}

export function healthIframeIsCurrent(iframe: HTMLElement | null | undefined, bot: StreamBot | null | undefined): boolean {
  const key = frameKey(bot);
  return Boolean(iframe && key && iframe.dataset?.key === key);
}

export const CONNECTING_AFTER_MS = 5000;

export function shouldShowConnecting({ downSince, now }: { downSince: number | null | undefined; now: number }): boolean {
  if (!downSince) return false;
  return now - downSince >= CONNECTING_AFTER_MS;
}
