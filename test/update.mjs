import { isNewer, pickAsset, SITE_URL } from "../server/update.mjs";

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

test("official site", () => {
  assert(SITE_URL === "https://sub8.grok.me");
});

if (failed) process.exit(1);
