import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "sub8bot";
const REPO = "Sub8";
const LATEST = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;
export const SITE_URL = "https://sub8.bot";

export function appVersion() {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(fs.readFileSync(pkg, "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function normalizeVersion(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/)[0];
}

export function isNewer(latest, current) {
  const a = normalizeVersion(latest).split(".").map((n) => Number(n) || 0);
  const b = normalizeVersion(current).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

export function pickAsset(assets = [], platform = process.platform, arch = process.arch) {
  const names = assets
    .map((a) => ({
      name: String(a.name || ""),
      url: a.browser_download_url || a.url,
    }))
    .filter((a) => a.url && !/\.blockmap$|\.sha256$/i.test(a.name));
  const lower = (s) => s.toLowerCase();
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

export async function checkForAppUpdate({
  current = appVersion(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  try {
    const res = await fetch(LATEST, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Sub8/${current}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        currentVersion: current,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: RELEASES_PAGE,
        downloadUrl: null,
        siteUrl: SITE_URL,
        error: `GitHub returned HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    const tag = data.tag_name || "";
    const latest = normalizeVersion(tag);
    const asset = pickAsset(data.assets, platform, arch);
    const newer = Boolean(latest && isNewer(latest, current));
    const ready = Boolean(asset?.url);
    return {
      currentVersion: normalizeVersion(current),
      latestVersion: latest || null,
      // Never alert on a published tag with no installer yet.
      updateAvailable: newer && ready,
      tagName: tag,
      releaseName: data.name || tag,
      releaseUrl: data.html_url || RELEASES_PAGE,
      downloadUrl: asset?.url || null,
      downloadName: asset?.name || null,
      siteUrl: SITE_URL,
      error: newer && !ready ? "A newer version is tagged, but the installer is not up yet." : null,
    };
  } catch (err) {
    return {
      currentVersion: current,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: RELEASES_PAGE,
      downloadUrl: null,
      siteUrl: SITE_URL,
      error: err.message || String(err),
    };
  }
}
