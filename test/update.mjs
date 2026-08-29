import { isNewer, pickAsset, parseLatestTag, parseAtomLatestTag, assetsForTag, latestManifest, releaseFromManifest, SITE_URL, latestJsonUrl } from "../server/update.mjs";

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok  ${name}`);
    console.error(err);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

test("newer patch is newer", () => {
  assert(isNewer("0.3.14", "0.3.13"));
  assert(!isNewer("0.3.13", "0.3.14"));
  assert(!isNewer("0.3.13", "0.3.13"));
});

test("empty release has no installer", () => {
  assert(!pickAsset([], "darwin", "arm64"));
  assert(!pickAsset([{ name: "latest.yml", url: "https://example/latest.yml" }], "darwin", "arm64"));
});

test("picks the platform installer", () => {
  const assets = [
    { name: "Sub8-mac-arm64.dmg", url: "https://example/Sub8-mac-arm64.dmg" },
    { name: "Sub8-win-x64.exe", url: "https://example/Sub8-win-x64.exe" },
    { name: "Sub8-linux-x86_64.AppImage", url: "https://example/Sub8-linux-x86_64.AppImage" },
  ];
  assert(pickAsset(assets, "darwin", "arm64").name === "Sub8-mac-arm64.dmg");
  assert(pickAsset(assets, "win32", "x64").name === "Sub8-win-x64.exe");
  assert(pickAsset(assets, "linux", "x64").name === "Sub8-linux-x86_64.AppImage");
});

test("stable GitHub tag and installer names", () => {
  assert(parseLatestTag("https://github.com/sub8bot/Sub8/releases/tag/v0.3.32") === "v0.3.32");
  assert(parseLatestTag("https://github.com/sub8bot/Sub8/releases/tag/v0.3.32?foo=1") === "v0.3.32");
  assert(parseLatestTag("") === "");
  const assets = assetsForTag("v0.3.32");
  assert(assets.some((a) => a.name === "Sub8-mac-arm64.dmg"));
  assert(String(assets.find((a) => a.name === "Sub8-mac-arm64.dmg")?.browser_download_url).includes("/v0.3.32/Sub8-mac-arm64.dmg"));
  assert(pickAsset(assets, "darwin", "arm64").name === "Sub8-mac-arm64.dmg");
  assert(pickAsset(assets, "win32", "x64").name === "Sub8-win-x64.exe");
});

test("atom feed yields the latest tag without the API", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Sub8 0.3.32 (macOS)</title>
    <link rel="alternate" type="text/html" href="https://github.com/sub8bot/Sub8/releases/tag/v0.3.32"/>
  </entry>
  <entry>
    <link rel="alternate" href="https://github.com/sub8bot/Sub8/releases/tag/v0.3.31"/>
  </entry>
</feed>`;
  assert(parseAtomLatestTag(xml) === "v0.3.32");
  assert(parseAtomLatestTag("") === "");
});

test("site latest.json round-trips into a picker row", () => {
  const body = latestManifest("0.3.33");
  assert(body.tag === "v0.3.33");
  assert(body.version === "0.3.33");
  assert(body.siteUrl === SITE_URL);
  assert(body.downloads.some((d) => d.name === "Sub8-mac-arm64.dmg" && d.url.includes("/v0.3.33/Sub8-mac-arm64.dmg")));
  const rel = releaseFromManifest(body);
  assert(rel.tag_name === "v0.3.33");
  assert(pickAsset(rel.assets, "darwin", "arm64").name === "Sub8-mac-arm64.dmg");
  assert(pickAsset(rel.assets, "win32", "x64").name === "Sub8-win-x64.exe");
  assert(!releaseFromManifest({}));
});

test("official site", () => {
  assert(SITE_URL === "https://sub8.bot");
  assert(latestJsonUrl() === "https://sub8.bot/latest.json");
});

test("a prerelease is older than the release it precedes", () => {
  // release.mjs advertises `0.3.32-test`, and it used to be published without
  // --prerelease, so GitHub served it from /releases/latest to everyone.
  // normalizeVersion strips the suffix before the numeric split, so both of
  // these compared equal and returned false — anyone on the test build was
  // told they were current and never offered the real release.
  assert(isNewer("0.3.32", "0.3.32-test") === true, "the real release beats the test build");
  assert(isNewer("0.3.32-test", "0.3.32") === false, "a prerelease never beats its own release");
  assert(isNewer("0.3.32-test", "0.3.32-test") === false, "identical prereleases are not newer");
  // Plain comparisons are unchanged.
  assert(isNewer("0.3.32", "0.3.31") === true, "patch bump still newer");
  assert(isNewer("0.3.31", "0.3.32") === false, "older is not newer");
  assert(isNewer("0.3.32", "0.3.32") === false, "same is not newer");
  // A prerelease of a HIGHER version still beats a lower release.
  assert(isNewer("0.4.0-test", "0.3.32") === true, "a higher prerelease still wins");
});

if (failed) process.exit(1);
