import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One row of a GitHub release's `assets`, as the API sends it. */
export interface ReleaseAsset {
  name?: unknown;
  url?: string | undefined;
  browser_download_url?: string | undefined;
}

/** The slice of a GitHub release payload this module reads. */
export interface GithubRelease {
  tag_name?: string | undefined;
  name?: string | undefined;
  html_url?: string | undefined;
  assets?: ReleaseAsset[] | undefined;
}

/** An asset narrowed to the two fields the picker and its callers read. */
export interface PickedAsset {
  name: string;
  url: string | undefined;
}

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  downloadUrl: string | null;
  siteUrl: string;
  error: string | null;
  tagName?: string;
  releaseName?: string;
  downloadName?: string | null;
}

const OWNER = "sub8bot";
const REPO = "Sub8";
const GH = `https://github.com/${OWNER}/${REPO}`;
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const LATEST_PAGE = `${GH}/releases/latest`;
const LATEST_ATOM = `${GH}/releases.atom`;
const RELEASES_PAGE = `${GH}/releases`;
export const SITE_URL = "https://sub8.bot";
const LOOKUP_MS = 6_000;
const UNREACHABLE = "Could not reach GitHub Releases. Try sub8.bot.";

/**
 * electron-builder `artifactName` is `${productName}-${os}-${arch}.${ext}` —
 * version-independent, so these names stay stable across releases. The in-app
 * checker uses them when GitHub's API 403s unauthenticated traffic (it now
 * returns an HTML Forbidden page instead of JSON).
 */
export const STABLE_INSTALLERS = [
  "Sub8-mac-arm64.dmg",
  "Sub8-mac-x64.dmg",
  "Sub8-mac-arm64.zip",
  "Sub8-mac-x64.zip",
  "Sub8-win-x64.exe",
  "Sub8-win-x64.zip",
  "Sub8-linux-x86_64.AppImage",
  "Sub8-linux-x64.tar.gz",
] as const;

export function parseLatestTag(url: unknown): string {
  const m = String(url || "").match(/\/releases\/tag\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

/** First `<entry>` in GitHub's public releases Atom feed. */
export function parseAtomLatestTag(xml: unknown): string {
  const entry = String(xml || "").match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] || "";
  return (
    parseLatestTag(entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]) ||
    parseLatestTag(entry) ||
    ""
  );
}

export function downloadUrlFor(tag: string, name: string): string {
  return `${GH}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

export function assetsForTag(tag: string): ReleaseAsset[] {
  return STABLE_INSTALLERS.map((name) => ({
    name,
    browser_download_url: downloadUrlFor(tag, name),
  }));
}

export function appVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(fs.readFileSync(pkg, "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function normalizeVersion(v: unknown): string {
  return (
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      // String.prototype.split always yields at least one element, so [0] is
      // never undefined here; noUncheckedIndexedAccess cannot know that.
      .split(/[-+]/)[0]!
  );
}

/** The `-suffix` part, or "" for a plain release. */
function preRelease(v: unknown): string {
  const m = /^v?\d+(?:\.\d+)*[-+](.+)$/.exec(String(v ?? "").trim());
  return m ? String(m[1]) : "";
}

export function isNewer(latest: unknown, current: unknown): boolean {
  const a = normalizeVersion(latest).split(".").map((n) => Number(n) || 0);
  const b = normalizeVersion(current).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  // Same numbers: a prerelease is OLDER than the release it precedes, per
  // semver. normalizeVersion strips the suffix before the numeric split, so
  // "0.3.32-test" and "0.3.32" compared equal and returned false both ways --
  // which stranded anyone running a test build, because the real 0.3.32 was
  // then never offered to them.
  const pa = preRelease(latest);
  const pb = preRelease(current);
  if (pa === pb) return false;
  if (!pa) return true; // a release beats the prerelease of the same version
  if (!pb) return false; // a prerelease never beats its own release
  return pa > pb; // both prereleases: fall back to a stable ordering
}

export function pickAsset(
  assets: readonly ReleaseAsset[] = [],
  platform: string = process.platform,
  arch: string = process.arch,
): PickedAsset | undefined {
  const names = assets
    .map((a) => ({
      name: String(a.name || ""),
      url: a.browser_download_url || a.url,
    }))
    .filter((a) => a.url && !/\.blockmap$|\.sha256$/i.test(a.name));
  const lower = (s: string) => s.toLowerCase();
  if (platform === "darwin") {
    const tag = arch === "arm64" ? "mac-arm64" : "mac-x64";
    return (
      names.find((a) => lower(a.name).includes(tag) && a.name.endsWith(".dmg")) ||
      names.find((a) => lower(a.name).includes(tag) && a.name.endsWith(".zip")) ||
      names.find((a) => lower(a.name).endsWith(".dmg"))
    );
  }
  if (platform === "win32") {
    return (
      names.find((a) => /sub8-win-x64\.exe$/i.test(a.name)) ||
      names.find((a) => a.name.endsWith(".exe") && !/uninstall/i.test(a.name)) ||
      names.find((a) => /win.*\.zip$/i.test(a.name))
    );
  }
  return (
    names.find((a) => /appimage$/i.test(a.name)) ||
    names.find((a) => /linux.*\.tar\.gz$/i.test(a.name))
  );
}

function apiHeaders(current: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `Sub8/${current}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function uaHeaders(current: string): Record<string, string> {
  return { "User-Agent": `Sub8/${current}`, Accept: "text/html,application/atom+xml,*/*" };
}

/** First successful promise value; ignores nulls and throws. */
function firstHit<T>(jobs: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let left = jobs.length;
    if (!left) return resolve(null);
    for (const job of jobs) {
      job.then(
        (value) => {
          if (value) resolve(value);
          else if (--left === 0) resolve(null);
        },
        () => {
          if (--left === 0) resolve(null);
        },
      );
    }
  });
}

function releaseFromTag(tag: string, extra: Partial<GithubRelease> = {}): GithubRelease | null {
  if (!tag) return null;
  return {
    tag_name: tag,
    name: extra.name || tag,
    html_url: extra.html_url || `${GH}/releases/tag/${tag}`,
    assets: extra.assets?.length ? extra.assets : assetsForTag(tag),
  };
}

async function fetchLatestFromApi(current: string): Promise<GithubRelease | null> {
  try {
    const res = await fetch(LATEST_API, {
      headers: apiHeaders(current),
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
    // 403 here is GitHub refusing unauthenticated API traffic (HTML Forbidden
    // page). Naming is fine — do not surface the status.
    if (!res.ok) return null;
    const type = String(res.headers.get("content-type") || "");
    if (!type.includes("json")) return null;
    const data = (await res.json()) as GithubRelease;
    return data?.tag_name ? releaseFromTag(data.tag_name, data) : null;
  } catch {
    return null;
  }
}

async function fetchLatestFromAtom(current: string): Promise<GithubRelease | null> {
  try {
    const res = await fetch(LATEST_ATOM, {
      headers: uaHeaders(current),
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
    if (!res.ok) return null;
    return releaseFromTag(parseAtomLatestTag(await res.text()));
  } catch {
    return null;
  }
}

async function fetchLatestFromPage(current: string): Promise<GithubRelease | null> {
  const headers = uaHeaders(current);
  try {
    const head = await fetch(LATEST_PAGE, {
      method: "HEAD",
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
    const fromHead = parseLatestTag(head.headers.get("location") || head.url);
    if (fromHead) return releaseFromTag(fromHead);
  } catch {
    /* GET next */
  }
  try {
    const res = await fetch(LATEST_PAGE, {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(LOOKUP_MS),
    });
    return releaseFromTag(parseLatestTag(res.url) || parseLatestTag(res.headers.get("location")));
  } catch {
    return null;
  }
}

async function installerReady(url: string, current: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": `Sub8/${current}` },
      signal: AbortSignal.timeout(4_000),
    });
    // 404 = that OS is not on this tag. 2xx/3xx = the file is there.
    // Never GET — a missed Range header would download a 100MB+ installer.
    if (res.status === 404 || res.status === 410) return false;
    return res.ok || res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308;
  } catch {
    // GitHub blocking HEAD must not hide a real update. Stable names are enough.
    return true;
  }
}

export async function checkForAppUpdate({
  current = appVersion(),
  platform = process.platform,
  arch = process.arch,
}: { current?: string; platform?: string; arch?: string } = {}): Promise<AppUpdateStatus> {
  const empty = {
    currentVersion: normalizeVersion(current) || current,
    latestVersion: null as string | null,
    updateAvailable: false,
    releaseUrl: RELEASES_PAGE,
    downloadUrl: null as string | null,
    siteUrl: SITE_URL,
    error: null as string | null,
  };
  try {
    const data = await firstHit([
      fetchLatestFromApi(current),
      fetchLatestFromAtom(current),
      fetchLatestFromPage(current),
    ]);
    if (!data?.tag_name) return { ...empty, error: UNREACHABLE };
    const tag = data.tag_name;
    const latest = normalizeVersion(tag);
    const asset = pickAsset(data.assets?.length ? data.assets : assetsForTag(tag), platform, arch);
    const newer = Boolean(latest && isNewer(latest, current));
    let ready = Boolean(asset?.url);
    if (ready && asset?.url) ready = await installerReady(asset.url, current);
    return {
      currentVersion: normalizeVersion(current) || current,
      latestVersion: latest || null,
      updateAvailable: newer && ready,
      tagName: tag,
      releaseName: data.name || tag,
      releaseUrl: data.html_url || RELEASES_PAGE,
      downloadUrl: ready ? asset?.url || null : null,
      downloadName: ready ? asset?.name || null : null,
      siteUrl: SITE_URL,
      error: newer && !ready ? "A newer version is tagged, but the installer for this computer is not up yet." : null,
    };
  } catch {
    return { ...empty, error: UNREACHABLE };
  }
}
