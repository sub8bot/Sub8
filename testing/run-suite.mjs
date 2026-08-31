/**
 * Run every file in test/ as its own process, with a per-file timeout.
 *
 * `npm test` used to be one long `&&` chain, which has two problems that both
 * bit during this session:
 *
 *  - No timeout. 47 of the 61 files never call process.exit, so they rely on
 *    the event loop draining; ONE stray handle and the chain stalls forever
 *    with no diagnosis. test/mcp-desk.mjs did exactly that twice — printing
 *    "ok" and then sitting for 30+ minutes — while exiting in 0.09s on its own.
 *    A hang is now a reported failure with a duration, not a silent stall.
 *
 *  - Nothing checked the list against the directory. test/vm-guards.mjs,
 *    test/settings-key.mjs, test/teams-remove.mjs and
 *    test/mcp-shell-report.mjs had all been written, committed, and never run
 *    once, because adding a file to test/ does not add it to the chain. The
 *    orphan check below fails the suite instead of quietly skipping them.
 *
 * Order is preserved from the old chain: some files are slower and were placed
 * deliberately, and a couple share fixed ports so running them concurrently is
 * not safe. This runs them one at a time for the same reason.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(root, "test");

/** Per-file ceiling. The slowest legitimate file is a few seconds. */
const TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 200_000);

/**
 * Files that are deliberately not run here, with the reason. Anything else in
 * test/ that is missing from ORDER fails the suite.
 */
const EXCLUDED = new Map([]);

/** The chain's original order, plus the four orphans it never included. */
const ORDER = [
  "vault.mjs",
  "vault-routing.mjs",
  "isolation.mjs",
  "context.mjs",
  "delivery.mjs",
  "tunnels.mjs",
  "update.mjs",
  "vm-status.mjs",
  "login-intent.mjs",
  "host-cli-auth.mjs",
  "cursor-cli.mjs",
  "account.mjs",
  "cloud-draft.mjs",
  "docker-queue.mjs",
  "docker-install.mjs",
  "qwen-pack.mjs",
  "hermes-config.mjs",
  "mcp-config.mjs",
  "mcp-heal.mjs",
  "mcp-cloud-agent.mjs",
  "harness-models.mjs",
  "harness-proxy.mjs",
  "codex-catalog.mjs",
  "grok-stream.mjs",
  "desk-harness.mjs",
  "desk-harness-latch.mjs",
  "teams.mjs",
  "bot-identity.mjs",
  "channel-routes.mjs",
  "orchestration-layout.mjs",
  "subagents.mjs",
  "code-agent.mjs",
  "memory.mjs",
  "projects.mjs",
  "update-state.mjs",
  "read-file.mjs",
  "box-input.mjs",
  "desk.mjs",
  "display.mjs",
  "jobs.mjs",
  "teammate.mjs",
  "tools-catalog.mjs",
  "desk-client.mjs",
  "desk-stop.mjs",
  "in-desk-harness.mjs",
  "mcp-desk.mjs",
  "app-boot.mjs",
  "delegated-acts.mjs",
  "chat-merge.mjs",
  "chat-activity.mjs",
  "control-route.mjs",
  "latency.mjs",
  "type-keys.mjs",
  "markdown.mjs",
  "brain-setup.mjs",
  "api-client.mjs",
  "icons.mjs",
  "cloud-place.mjs",
  "vm-guards.mjs",
  "vm-inject.mjs",
  "mcp-redaction.mjs",
  "api-hardening.mjs",
  "teams-concurrency.mjs",
  "teams-create.mjs",
  "mcp-shell-report.mjs",
  "settings-key.mjs",
  "teams-remove.mjs",
  "secret-file-modes.mjs",
  "conversation-safety.mjs",
  "durability.mjs",
  "secret-card-copy.mjs",
];

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ file, ok: false, timedOut: true, ms: Date.now() - started, out });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ file, ok: false, ms: Date.now() - started, out: String(err?.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, code, ms: Date.now() - started, out });
    });
  });
}

const onDisk = (await fs.readdir(TEST_DIR)).filter((f) => f.endsWith(".mjs")).sort();
const listed = new Set([...ORDER, ...EXCLUDED.keys()]);
const orphans = onDisk.filter((f) => !listed.has(f));
const missing = ORDER.filter((f) => !onDisk.includes(f));

const results = [];
for (const file of ORDER) {
  if (!onDisk.includes(file)) continue;
  const r = await runOne(file);
  results.push(r);
  const mark = r.ok ? "ok  " : r.timedOut ? "HANG" : "FAIL";
  console.log(`${mark} ${file} (${r.ms}ms)`);
  if (!r.ok) {
    const tail = r.out.split("\n").filter(Boolean).slice(-6).join("\n");
    if (tail) console.log(tail.replace(/^/gm, "     "));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} files passed`);
if (orphans.length) {
  console.error(`\n${orphans.length} test file(s) exist but are not in the run list — they have never run:`);
  for (const f of orphans) console.error(`  test/${f}`);
  console.error("Add them to ORDER in testing/run-suite.mjs, or to EXCLUDED with a reason.");
}
if (missing.length) console.error(`\nListed but missing from test/: ${missing.join(", ")}`);
for (const r of failed) console.error(r.timedOut ? `HANG ${r.file} (killed at ${TIMEOUT_MS}ms)` : `FAIL ${r.file}`);

process.exit(failed.length || orphans.length || missing.length ? 1 : 0);
