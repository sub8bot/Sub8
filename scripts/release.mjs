#!/usr/bin/env node
// Deterministic, single-command Sub8 release.
//
// One blocking flow: build (all OS) -> sign + notarize (mac) -> verify -> publish.
// No agent, no stall. Every stage runs to completion or the process exits non-zero.
//
//   node scripts/release.mjs <version>            # dry-run: build + verify, NO publish
//   node scripts/release.mjs <version> --publish  # also cut the GitHub release
//   node scripts/release.mjs <version> --dry-run  # explicit dry-run (same as no --publish)
//   node scripts/release.mjs <version> --skip-build   # re-use dist/ from a prior run
//   node scripts/release.mjs --help
//
// Notes:
//   * The package.json version is NEVER edited; the build gets it via
//     -c.extraMetadata.version=<version>.
//   * The GitHub tag points at the current PUBLIC origin/master commit. No source push.
//   * Only the built binaries are uploaded. latest*.yml is intentionally omitted
//     (auto-update is a separate decision — see robustness T9). After GitHub,
//     this PUTs https://sub8.bot/latest.json so the app checks the site first.
//   * Windows is not Authenticode-signed yet; an unsigned Windows build is allowed (warns).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "sub8bot/Sub8";

// ---- tiny logging helpers -------------------------------------------------
const csi = (n) => (process.stdout.isTTY ? n : "");
const bold = (s) => `${csi("\x1b[1m")}${s}${csi("\x1b[0m")}`;
const green = (s) => `${csi("\x1b[32m")}${s}${csi("\x1b[0m")}`;
const yellow = (s) => `${csi("\x1b[33m")}${s}${csi("\x1b[0m")}`;
const red = (s) => `${csi("\x1b[31m")}${s}${csi("\x1b[0m")}`;

let STAGE = 0;
function stage(msg) {
  STAGE += 1;
  console.log(`\n${bold(`==> [${STAGE}] ${msg}`)}`);
}
function info(msg) { console.log(`    ${msg}`); }
function ok(msg) { console.log(`    ${green("OK")} ${msg}`); }
function warn(msg) { console.log(`    ${yellow("WARN")} ${msg}`); }
function die(msg, code = 1) {
  console.error(`\n${red("RELEASE FAILED:")} ${msg}`);
  process.exit(code);
}

// Run a command, streaming output. Throws (fails the release) on non-zero exit.
function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.error) die(`${cmd} could not start: ${r.error.message}`);
  if (typeof r.status === "number" && r.status !== 0) {
    die(`${cmd} exited with code ${r.status}`, r.status);
  }
  return r;
}

// Run a command capturing stdout; never throws (caller decides).
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  return { status: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function cloudBaseUrl() {
  return String(process.env.SUB8_CLOUD_URL || "https://sub8.bot").replace(/\/$/, "");
}

function latestPublishToken() {
  return String(process.env.SUB8_LATEST_TOKEN || process.env.LATEST_PUBLISH_TOKEN || "").trim();
}

/** Tell sub8.bot what GitHub just shipped. Warns on failure — the GitHub release still stands. */
async function publishLatestJson(version) {
  const { latestManifest } = await import("../server/update.mjs");
  const body = latestManifest(version, { publishedAt: new Date().toISOString() });
  const token = latestPublishToken();
  const url = `${cloudBaseUrl()}/api/admin/latest`;
  if (token) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Sub8-release",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        ok(`sub8.bot/latest.json -> ${body.tag}`);
        return true;
      }
      warn(`sub8.bot latest.json HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      warn(`sub8.bot latest.json: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    warn("SUB8_LATEST_TOKEN unset — trying wrangler kv put");
  }
  const cloudDir = String(process.env.SUB8_CLOUD_DIR || path.join(ROOT, "cloud"));
  if (!existsSync(path.join(cloudDir, "wrangler.jsonc"))) {
    warn(`no wrangler.jsonc in ${cloudDir} — skip latest.json`);
    return false;
  }
  const tmp = path.join(tmpdir(), `sub8-latest-${version}.json`);
  writeFileSync(tmp, JSON.stringify(body));
  try {
    const r = capture("npx", ["wrangler", "kv", "key", "put", "app:latest", "--binding", "KV", "--remote", `--path=${tmp}`], {
      cwd: cloudDir,
    });
    if (r.status !== 0) {
      warn(`wrangler kv put latest.json failed: ${r.err || r.out}`);
      return false;
    }
    ok(`sub8.bot/latest.json -> ${body.tag} (wrangler kv)`);
    return true;
  } finally {
    try {
      rmSync(tmp);
    } catch {
      /* tmp */
    }
  }
}

// ---- arg parsing ----------------------------------------------------------
const USAGE = `Sub8 deterministic release

Usage:
  node scripts/release.mjs <version> [flags]

Arguments:
  <version>        Version to build, e.g. 0.3.32 (must be semver). Injected via
                   electron-builder -c.extraMetadata.version; package.json is not edited.

Flags:
  --publish        Cut the GitHub release (create tag on origin/master + upload
                   binaries). WITHOUT this flag the script is a dry-run: it builds
                   and verifies everything, then prints exactly what it WOULD upload.
  --dry-run        Explicit dry-run. Same effect as omitting --publish.
  --skip-build     Skip the electron-builder build and re-use the existing dist/
                   artifacts (for a fast re-run of verify/publish).
  --skip-notarize  Skip the mac notarization step (verify will then likely fail
                   the notarized check unless dmgs were already notarized).
  -h, --help       Show this help.

Stages (all blocking, non-zero exit on any failure):
  1. Build all OS (mac dmg+zip arm64/x64, win nsis+zip x64, linux AppImage+tar.gz x64).
  2. Sign + notarize + staple the mac dmgs.
  3. Verify: mac dmgs notarized (spctl accepted), app.asar has cloud OFF, per-OS
     signing status. Windows unsigned is allowed (warns).
  4. Publish (only with --publish): tag current origin/master, upload the 8 binaries.
  5. PUT https://sub8.bot/latest.json so in-app update checks the site first.

Examples:
  node scripts/release.mjs 0.3.32              # dry-run
  node scripts/release.mjs 0.3.32 --publish    # real release
`;

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positionals = argv.filter((a) => !a.startsWith("-"));
const KNOWN = new Set(["--publish", "--dry-run", "--skip-build", "--skip-notarize", "--replace-published", "-h", "--help"]);
for (const f of flags) if (!KNOWN.has(f)) die(`unknown flag: ${f}\n\n${USAGE}`);

if (positionals.length === 0) die(`missing <version>.\n\n${USAGE}`);
if (positionals.length > 1) die(`too many positional args: ${positionals.join(" ")}\n\n${USAGE}`);

const VERSION = positionals[0];
// Loose semver check (allows prerelease like 0.3.32-test).
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(VERSION)) {
  die(`"${VERSION}" is not a valid semver version (e.g. 0.3.32 or 0.3.32-test).`);
}

const PUBLISH = flags.has("--publish");
const DRY_RUN = flags.has("--dry-run") || !PUBLISH;
const SKIP_BUILD = flags.has("--skip-build");
const SKIP_NOTARIZE = flags.has("--skip-notarize");
const TAG = `v${VERSION}`;

// Expected artifacts. artifactName in package.json is version-independent
// (${productName}-${os}-${arch}.${ext}), so these filenames are stable.
const BINARIES = [
  { file: "Sub8-mac-arm64.dmg", os: "mac" },
  { file: "Sub8-mac-x64.dmg", os: "mac" },
  { file: "Sub8-mac-arm64.zip", os: "mac" },
  { file: "Sub8-mac-x64.zip", os: "mac" },
  { file: "Sub8-win-x64.exe", os: "win" },
  { file: "Sub8-win-x64.zip", os: "win" },
  { file: "Sub8-linux-x86_64.AppImage", os: "linux" },
  { file: "Sub8-linux-x64.tar.gz", os: "linux" },
];
const dist = (f) => path.join(ROOT, "dist", f);

console.log(bold(`Sub8 release ${VERSION}  (tag ${TAG})`));
console.log(DRY_RUN ? yellow("MODE: DRY-RUN (no GitHub publish)") : green("MODE: PUBLISH"));

// ---- preflight ------------------------------------------------------------
stage("Preflight");

// Resolve the public origin/master commit the tag will point at.
const om = capture("git", ["rev-parse", "origin/master"]);
if (om.status !== 0 || !om.out) {
  die("could not resolve origin/master (run `git fetch origin` first).");
}
const TARGET_SHA = om.out;
const head = capture("git", ["rev-parse", "HEAD"]).out;
const shortTarget = capture("git", ["rev-parse", "--short", TARGET_SHA]).out || TARGET_SHA.slice(0, 8);
info(`Tag ${TAG} -> origin/master @ ${shortTarget}`);
if (head && head !== TARGET_SHA) {
  info(`(local HEAD ${head.slice(0, 8)} is ahead of origin/master; the tag uses the PUBLIC commit, not HEAD.)`);
}

// gh is only strictly required when actually publishing.
const ghOk = capture("gh", ["--version"]).status === 0;
if (PUBLISH) {
  if (!ghOk) die("`gh` (GitHub CLI) is not installed but --publish was requested.");
  const auth = capture("gh", ["auth", "status", "--hostname", "github.com"]);
  if (auth.status !== 0) die("`gh auth status` failed — run `gh auth login` before --publish.");
  ok("gh installed and authenticated");
} else if (!ghOk) {
  warn("gh not found — fine for a dry-run; required for --publish.");
}

const isMac = process.platform === "darwin";
if (!isMac) warn(`building on ${process.platform}: mac signing/notarization/spctl will be skipped.`);

// ---- stage 1: build -------------------------------------------------------
stage(SKIP_BUILD ? "Build (SKIPPED, re-using dist/)" : "Build all OS via electron-builder");
const verArg = `-c.extraMetadata.version=${VERSION}`;
if (SKIP_BUILD) {
  info("--skip-build: not invoking electron-builder.");
} else {
  info(`Version injected via ${verArg} (package.json is NOT edited).`);
  run("npm", ["run", "icons"]);

  // Mac first so we can sign+notarize before moving on.
  if (isMac) {
    run("npx", ["electron-builder", "--mac", "dmg", "zip", "--arm64", "--x64", verArg]);
  } else {
    warn("skipping mac build (not on darwin).");
  }
  run("npx", ["electron-builder", "--win", "nsis", "zip", "--x64", verArg]);
  run("npx", ["electron-builder", "--linux", "AppImage", "tar.gz", "--x64", verArg]);
}

// ---- stage 2: sign + notarize mac ----------------------------------------
stage("Sign + notarize mac dmgs");
if (!isMac) {
  warn("not on darwin — skipping notarization.");
} else if (SKIP_NOTARIZE) {
  warn("--skip-notarize: leaving mac artifacts as-is.");
} else if (SKIP_BUILD) {
  info("--skip-build: assuming dmgs were already notarized in a prior run; verify will confirm.");
} else {
  for (const f of ["Sub8-mac-arm64.dmg", "Sub8-mac-x64.dmg"]) {
    if (existsSync(dist(f))) {
      run("bash", ["scripts/sign-and-notarize.sh", path.join("dist", f)]);
    } else {
      warn(`${f} not found to notarize.`);
    }
  }
}

// ---- stage 3: verify ------------------------------------------------------
stage("Verify build");
let hardFail = false;

// 3a. all expected binaries exist.
const missing = [];
for (const b of BINARIES) if (!existsSync(dist(b.file))) missing.push(b.file);
if (missing.length) {
  for (const m of missing) console.log(`    ${red("MISSING")} ${m}`);
  hardFail = true;
} else {
  ok(`all ${BINARIES.length} binaries present in dist/`);
}

// 3b. per-OS signing status + mac notarization (spctl accepted).
info(bold("Signing status:"));
for (const b of BINARIES) {
  if (!existsSync(dist(b.file))) continue;
  if (b.os === "mac") {
    if (!isMac) { warn(`${b.file}: cannot check signature off-darwin`); continue; }
    if (b.file.endsWith(".dmg")) {
      // Notarized + stapled dmgs are accepted by Gatekeeper for install.
      const sp = capture("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dist(b.file)]);
      const accepted = sp.status === 0 && /accepted/i.test(`${sp.out}\n${sp.err}`);
      if (accepted) ok(`${b.file}: signed + notarized (spctl accepted)`);
      else { console.log(`    ${red("FAIL")} ${b.file}: NOT notarized/accepted by spctl`); hardFail = true; }
    } else {
      // A .zip is not itself code-signable; the signature lives on the .app inside.
      // Verify the corresponding built app bundle instead.
      const appDir = b.file.includes("arm64")
        ? path.join(ROOT, "dist/mac-arm64/Sub8.app")
        : path.join(ROOT, "dist/mac/Sub8.app");
      if (!existsSync(appDir)) { warn(`${b.file}: cannot locate ${path.relative(ROOT, appDir)} to verify the app inside`); continue; }
      const acs = capture("codesign", ["-dv", "--verbose=2", appDir]);
      const appSigned = /Developer ID Application/.test(`${acs.out}\n${acs.err}`);
      const asp = capture("spctl", ["-a", "-t", "exec", "-vv", appDir]);
      const appAccepted = asp.status === 0 && /accepted/i.test(`${asp.out}\n${asp.err}`);
      if (appSigned && appAccepted) ok(`${b.file}: contains signed + notarized app (spctl accepted)`);
      else if (appSigned) { warn(`${b.file}: app signed but Gatekeeper not accepted (notarization may be pending)`); }
      else { console.log(`    ${red("FAIL")} ${b.file}: app inside is not Developer ID signed`); hardFail = true; }
    }
  } else if (b.os === "win") {
    warn(`${b.file}: Windows Authenticode signing not configured (unsigned build ALLOWED).`);
  } else {
    info(`${b.file}: linux artifact (unsigned, expected).`);
  }
}

// 3c. app.asar has cloud OFF.
info(bold("Cloud flag check (app.asar must have cloud OFF):"));
const asarApps = [
  "dist/mac-arm64/Sub8.app/Contents/Resources/app.asar",
  "dist/mac/Sub8.app/Contents/Resources/app.asar",
];
let checkedAsar = false;
for (const rel of asarApps) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) continue;
  checkedAsar = true;
  const tmp = mkdtempSync(path.join(tmpdir(), "sub8-asar-"));
  try {
    const ex = capture("npx", ["asar", "extract", p, tmp]);
    if (ex.status !== 0) { warn(`${rel}: asar extract failed (${ex.err || ex.out})`); continue; }
    const cat = capture("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(tmp, "electron/main.mjs"))}, 'utf8'))`]);
    const line = cat.out.split("\n").find((l) => l.includes("SUB8_CLOUD:")) || "";
    // Expect: SUB8_CLOUD: process.env.SUB8_CLOUD || (app.isPackaged ? "0" : ""),
    const cloudOff = /app\.isPackaged\s*\?\s*"0"/.test(line);
    const cloudOn = /app\.isPackaged\s*\?\s*"1"/.test(line);
    // The artifact must BE the version we are about to tag. Filenames carry no
    // version (artifactName is `${productName}-${os}-${arch}.${ext}`), dist/ is
    // never cleaned, and stage 3a only checks the eight names exist -- so
    // --skip-build would tag and publish a stale build byte-for-byte
    // indistinguishable from a fresh one. Every user would then run an app
    // whose appVersion() is older than the tag, and be told forever that the
    // version they just installed is available.
    const pkgRaw = capture("node", [
      "-e",
      `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(tmp, "package.json"))}, 'utf8'))`,
    ]);
    let builtVersion = "";
    try {
      builtVersion = String(JSON.parse(pkgRaw.out || "{}").version || "");
    } catch {
      builtVersion = "";
    }
    if (!builtVersion) {
      console.log(`    ${red("FAIL")} ${rel}: could not read the packaged version`);
      hardFail = true;
    } else if (builtVersion !== VERSION) {
      console.log(
        `    ${red("FAIL")} ${rel}: built version is ${builtVersion}, but you are releasing ${VERSION}` +
          ` — dist/ holds a stale build (rebuild, or drop --skip-build)`,
      );
      hardFail = true;
    } else {
      ok(`${rel}: version ${builtVersion}`);
    }
    if (cloudOff) ok(`${rel}: cloud OFF`);
    else if (cloudOn) { console.log(`    ${red("FAIL")} ${rel}: cloud is ON in packaged build`); hardFail = true; }
    else { console.log(`    ${red("FAIL")} ${rel}: could not confirm cloud flag (line: ${line.trim() || "not found"})`); hardFail = true; }
    const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const sub8Deps = Object.keys(rootPkg.dependencies || {}).filter((k) => k.startsWith("@sub8/"));
    const missingPkgs = sub8Deps.filter((name) => !existsSync(path.join(tmp, "node_modules", name, "package.json")));
    if (missingPkgs.length) {
      console.log(`    ${red("FAIL")} ${rel}: asar missing ${missingPkgs.join(", ")} — packaged app will whitescreen`);
      hardFail = true;
    } else {
      ok(`${rel}: ${sub8Deps.length} @sub8 packages in node_modules`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (!checkedAsar) {
  if (isMac) { console.log(`    ${red("FAIL")} no mac app.asar found to check the cloud flag`); hardFail = true; }
  else warn("no mac app.asar available to check cloud flag (off-darwin).");
}

if (hardFail) die("verification failed — see FAIL lines above. Nothing was published.");
ok("verification passed");

// ---- stage 4: publish (gated) --------------------------------------------
stage(PUBLISH ? "Publish to GitHub" : "Publish plan (DRY-RUN — nothing sent)");
const uploadFiles = BINARIES.map((b) => b.file);
console.log(`    Repo:   ${REPO}`);
console.log(`    Tag:    ${TAG}  ->  origin/master @ ${shortTarget}  (no source push)`);
console.log(`    Assets it WOULD upload (${uploadFiles.length}):`);
for (const f of uploadFiles) console.log(`      - dist/${f}`);
console.log(`    latest*.yml: omitted by design (auto-update decision pending, T9).`);
if (VERSION.includes("-")) {
  console.log(`    latest.json: skipped (prerelease — GitHub /releases/latest and sub8.bot stay on the last stable).`);
} else {
  console.log(`    latest.json: PUT ${cloudBaseUrl()}/api/admin/latest after GitHub.`);
  if (!latestPublishToken()) warn("SUB8_LATEST_TOKEN unset — publish will try wrangler kv, then skip.");
}

if (!PUBLISH) {
  console.log(`\n${yellow("DRY-RUN complete.")} Re-run with ${bold("--publish")} to cut the release.`);
  process.exit(0);
}

// A prerelease must be marked as one. Without --prerelease GitHub serves it
// from /releases/latest, every installed app polls that, and update.mts strips
// the -suffix -- so `0.3.32-test` shipped to everyone as "0.3.32 is available",
// and those users were then told they were current when the real 0.3.32
// landed, because both normalize to the same string.
const IS_PRERELEASE = VERSION.includes("-");

// Idempotency: if the release/tag already exists, don't recreate it.
const existing = capture("gh", ["release", "view", TAG, "--repo", REPO, "--json", "isDraft,url"]);
let existingDraft = false;
if (existing.status === 0) {
  try {
    existingDraft = Boolean(JSON.parse(existing.out || "{}").isDraft);
  } catch {
    existingDraft = false;
  }
}

if (existing.status === 0 && existingDraft) {
  // `gh release create` uploads assets and only then publishes, so a dropped
  // connection mid-upload leaves a DRAFT with no git tag. The old recovery
  // branch uploaded into it and printed "RELEASE PUBLISHED" without ever
  // publishing it or creating the tag -- the one path that had to recover was
  // the one that could not.
  warn(`release ${TAG} exists as a DRAFT (a previous run failed mid-upload) — completing it.`);
  run("gh", ["release", "upload", TAG, "--repo", REPO, "--clobber", ...uploadFiles.map((f) => dist(f))]);
  run("gh", ["release", "edit", TAG, "--repo", REPO, "--draft=false", ...(IS_PRERELEASE ? ["--prerelease"] : [])]);
} else if (existing.status === 0) {
  // Published already. --clobber DELETES the live assets before uploading, and
  // "if the upload fails, the original assets will be lost" -- so a re-run
  // could destroy the installers users are downloading, with no backup and no
  // rollback in this script. Make that an explicit choice, never a default.
  if (!process.argv.includes("--replace-published")) {
    die(
      `release ${TAG} is already PUBLISHED.\n` +
        `    Re-uploading uses --clobber, which deletes the live assets first; a failed\n` +
        `    upload loses them with no rollback. Cut a new version instead, or pass\n` +
        `    --replace-published if you really mean to overwrite a live release.`,
    );
  }
  warn(`overwriting the assets of PUBLISHED release ${TAG} (--replace-published).`);
  run("gh", ["release", "upload", TAG, "--repo", REPO, "--clobber", ...uploadFiles.map((f) => dist(f))]);
} else {
  run("gh", [
    "release", "create", TAG,
    "--repo", REPO,
    "--target", TARGET_SHA,
    "--title", `Sub8 ${VERSION}`,
    "--notes", `Sub8 ${VERSION}`,
    ...(IS_PRERELEASE ? ["--prerelease"] : []),
    ...uploadFiles.map((f) => dist(f)),
  ]);
}

// Say it shipped only once GitHub agrees it is published and the tag exists.
const after = capture("gh", ["release", "view", TAG, "--repo", REPO, "--json", "isDraft,tagName"]);
let published = false;
try {
  const row = JSON.parse(after.out || "{}");
  published = after.status === 0 && row.isDraft === false && row.tagName === TAG;
} catch {
  published = false;
}
if (!published) {
  die(`upload finished but ${TAG} is not published (still a draft, or the tag is missing). Nothing was announced.`);
}

if (IS_PRERELEASE) {
  warn(`not writing sub8.bot/latest.json — ${TAG} is a prerelease`);
} else {
  stage("Publish latest.json to sub8.bot");
  await publishLatestJson(VERSION);
}

console.log(`\n${green("RELEASE PUBLISHED:")} ${TAG} on ${REPO}${IS_PRERELEASE ? " (prerelease)" : ""}`);
process.exit(0);
