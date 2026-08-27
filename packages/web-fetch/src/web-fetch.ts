/**
 * Fetch a public URL as markdown-ish text.
 * MCP / tools-catalog (B4 or later) registers `web_fetch`; this file is the implementation.
 */

import { lookup as dnsLookup } from "node:dns/promises";

import type { FetchFn, FetchLike, WebFetchOptions, WebFetchResult } from "./types.js";

const MAX_BYTES = 750_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `dns.lookup(host, {all:true})`, injectable so a test need not touch the network. */
type LookupFn = (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * One numeric character reference, or "" when it names no character. The range
 * check is the point: String.fromCodePoint throws RangeError above U+10FFFF, so
 * `&#x110000;` on a page the MODEL chose used to crash web_fetch with a raw
 * RangeError instead of returning a page.
 */
function codePoint(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return "";
  return String.fromCodePoint(n);
}

function decodeEntities(s: unknown): string {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_: string, d: string) => codePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m: string, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

function stripTags(s: unknown): string {
  return decodeEntities(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function ipv4Parts(host: string): [number, number, number, number] | null {
  const p = String(host || "").split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return p as [number, number, number, number];
}

/**
 * An IPv4-mapped IPv6 address as a dotted quad, or "". The URL parser rewrites
 * `::ffff:127.0.0.1` to `::ffff:7f00:1`, so matching only the dotted form let
 * real loopback (and 10/172.16/192.168) straight through the blocklist.
 */
function mappedIpv4(host: string): string {
  const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i) as [string, string] | null;
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i) as [string, string, string] | null;
  if (!hex) return "";
  const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * The hostname as the blocklist must read it. EVERY trailing dot goes: the root
 * label may be written more than once, and stripping only one left
 * `http://127.0.0.1../` and `http://localhost../` passing the guard, because
 * `127.0.0.1.` has five dot-separated parts and matches no rule.
 */
function normalizeHost(host: string): string {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isBlockedHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h === "ip6-localhost") return true;
  if (h === "::1" || h === "0.0.0.0" || h === "::" || h === "0") return true;
  if (h === "metadata.google.internal") return true;
  const ip = mappedIpv4(h) || h;
  if (ip.includes(":")) {
    if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  }
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function blockedReason(host: string): string {
  const h = normalizeHost(host);
  const ip = mappedIpv4(h) || h;
  if (h === "localhost" || h.endsWith(".localhost") || ip === "::1" || ip.startsWith("127.")) {
    return "localhost URLs are blocked";
  }
  return "private URLs are blocked";
}

/** Public http(s) only. Rejects file:, data:, localhost, and RFC1918. */
export function assertPublicHttpUrl(raw: unknown): URL {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("url required");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("invalid url");
  }
  const proto = u.protocol.toLowerCase();
  if (proto === "file:") throw new Error("file: URLs are blocked");
  if (proto !== "http:" && proto !== "https:") throw new Error("only http/https URLs are allowed");
  if (isBlockedHost(u.hostname)) throw new Error(blockedReason(u.hostname));
  if (u.username || u.password) throw new Error("URLs with credentials are blocked");
  return u;
}

export function htmlToMarkdown(html: unknown): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // script/style/noscript are RAW TEXT elements: a browser reads their content
  // to the matching end tag or, failing that, to end of input. Requiring the
  // end tag meant an unterminated one leaked its source into the text handed to
  // the model — and the 750KB byte cap cuts pages at an arbitrary offset, so any
  // long page could end mid-script and spill JS as if it were prose.
  s = s.replace(/<(script|style|noscript)\b[\s\S]*?(?:<\/\1>|$)/gi, "");
  const titleRaw = (s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = titleRaw ? stripTags(titleRaw) : "";
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_: string, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t)}\n\n`);
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_: string, t: string) => `\n\n\`\`\`\n${decodeEntities(String(t).replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_: string, __: string, t: string) => `**${stripTags(t)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_: string, __: string, t: string) => `*${stripTags(t)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_: string, t: string) => `\`${stripTags(t)}\``);
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_: string, href: string, t: string) => `[${stripTags(t) || href}](${href})`);
  s = s.replace(/<img\b[^>]*>/gi, (m: string) => {
    const src = (m.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || "";
    const alt = (m.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    return src ? `![${alt}](${src})` : "";
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_: string, t: string) => `\n- ${stripTags(t)}`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<\/(p|div|tr|table|ul|ol|blockquote|section|article)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (title && !s.split("\n").some((line) => line.replace(/^#+\s*/, "") === title)) {
    s = `# ${title}${s ? `\n\n${s}` : ""}`;
  }
  return s;
}

function looksLikeHtml(text: unknown, contentType: unknown): boolean {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  const head = String(text || "").slice(0, 256).trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function toMarkdownText(body: unknown, contentType: unknown, finalUrl: string): string {
  const ct = String(contentType || "").toLowerCase();
  let text: string;
  if (ct.includes("application/json") || ct.includes("+json")) {
    const raw = String(body ?? "").trim();
    text = `\`\`\`json\n${raw}\n\`\`\``;
  } else if (looksLikeHtml(body, ct)) {
    text = htmlToMarkdown(body);
  } else {
    text = String(body ?? "").trim();
  }
  const src = `Source: ${finalUrl}`;
  return text ? `${src}\n\n${text}` : src;
}

function header(res: FetchLike | undefined, name: string): string {
  if (!res?.headers) return "";
  if (typeof res.headers.get === "function") return res.headers.get(name) || "";
  return (res.headers[name] || res.headers[name.toLowerCase()] || "") as string;
}

async function readBody(res: FetchLike, maxBytes: number): Promise<string> {
  if (typeof res.text === "function" && typeof res.arrayBuffer !== "function") {
    const text = await res.text();
    if (text.length > maxBytes) return `${text.slice(0, maxBytes)}\n\n[truncated]`;
    return text;
  }
  if (typeof res.arrayBuffer === "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    const text = slice.toString("utf8");
    return buf.length > maxBytes ? `${text}\n\n[truncated]` : text;
  }
  if (typeof res.text === "function") return res.text();
  return String(res.body ?? "");
}

/**
 * GET a public URL. Returns `{ kind: "web", url, finalUrl, status, contentType, text }`.
 * `fetch` may be injected (tests). Redirects are re-checked against the blocklist.
 */
/**
 * The blocklist above is a pure string match, so a PUBLIC name that resolves
 * into a private range walks straight through it: `127.0.0.1.nip.io` and
 * `localtest.me` both answer 127.0.0.1, and the local API on :8787 serves
 * /api/bots and /api/settings with no auth. The literal `http://127.0.0.1:8787`
 * is blocked; the DNS spelling of the same address was not.
 *
 * So resolve the host and re-run the same rules over every address it answers.
 *
 * Fail OPEN when resolution fails: a name that does not resolve cannot be
 * reached, so the fetch that follows fails on its own. That is also what keeps
 * the injected-fetch tests working, since they use names like `x.test`.
 *
 * This does NOT close DNS rebinding — the address is checked here and resolved
 * again by the fetch itself, so a record that changes in between still wins.
 * Closing that needs a custom agent pinning the checked address.
 */
export async function assertResolvesPublic(
  hostname: string,
  lookupFn: LookupFn = dnsLookup as LookupFn,
): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch {
    return;
  }
  for (const { address } of addresses) {
    if (isBlockedHost(address)) throw new Error(`${blockedReason(address)} (${hostname} resolves to ${address})`);
  }
}

export async function webFetch(url: unknown, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
  const fetchFn = (opts.fetch || globalThis.fetch) as FetchFn;
  if (typeof fetchFn !== "function") throw new Error("fetch is not available");
  const lookupFn = (opts.lookup || dnsLookup) as LookupFn;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_BYTES;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS;
  const maxRedirects = Number(opts.maxRedirects) >= 0 ? Number(opts.maxRedirects) : MAX_REDIRECTS;

  let current = assertPublicHttpUrl(url);
  const requested = current.href;
  let res: FetchLike;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertResolvesPublic(current.hostname, lookupFn);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await fetchFn(current.href, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: {
          Accept: "text/html,text/markdown,text/plain,application/json,application/xhtml+xml,*/*;q=0.8",
          "User-Agent": "Sub8-WebFetch/1.0",
        },
      });
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") throw new Error("web_fetch failed (timeout)");
      throw new Error(`web_fetch failed: ${(err as Error | undefined)?.message || err}`);
    } finally {
      clearTimeout(timer);
    }

    const status = Number(res?.status) || 0;
    if (REDIRECT_STATUSES.has(status)) {
      const loc = header(res, "location");
      if (!loc) throw new Error("redirect without location");
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        // `new URL("http://", base)` throws. A server that answers a redirect
        // to an unparseable Location must fail like every other bad hop, not
        // as a raw TypeError the caller has no branch for.
        throw new Error("redirect to an invalid url");
      }
      current = assertPublicHttpUrl(next.href);
      continue;
    }

    if (status >= 400 || status === 0) {
      throw new Error(`web_fetch failed (${status || "network"})`);
    }

    const contentType = header(res, "content-type");
    const body = await readBody(res, maxBytes);
    const text = toMarkdownText(body, contentType, current.href);
    return {
      kind: "web",
      url: requested,
      finalUrl: current.href,
      status,
      contentType,
      text,
    };
  }

  throw new Error("too many redirects");
}
