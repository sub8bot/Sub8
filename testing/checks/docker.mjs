/**
 * Docker lane — detection + install planning logic in server/vm.mjs.
 *
 *  - dockerStatus() resolves to a well-formed status on this machine
 *  - planDockerInstall cases:
 *      bare CLI (no engine)        → INSTALL an engine (not "recover")
 *      CLI + Docker Desktop/Colima → "recover"
 *      running daemon              → "noop"
 *      linux bare                  → engine-get-docker
 *      windows bare + winget       → winget-desktop
 *  - resolveDockerHost() returns a sane value (string, and never a dead forced socket)
 */
import path from "node:path";
import { BOT, freshImport } from "../lib/util.mjs";

export async function run(report) {
  let m;
  try {
    m = await freshImport(path.join(BOT, "server", "vm.mjs"));
  } catch (e) {
    report.record("vm.mjs module load", "docker", "FAIL", null, String(e?.message || e));
    return;
  }

  // live probe on this machine
  const t0 = Date.now();
  try {
    const st = await m.dockerStatus();
    report.check(
      st && typeof st.ok === "boolean",
      "dockerStatus resolves on this machine",
      "docker",
      Math.round((Date.now() - t0) / 1000),
      `ok=${st?.ok} engine=${st?.engine || "-"}`,
    );
  } catch (e) {
    report.record("dockerStatus resolves on this machine", "docker", "FAIL", null, String(e?.message || e));
  }

  // planDockerInstall cases
  const cases = [
    {
      tid: "bare CLI installs an engine (not recover)",
      facts: { platform: "darwin", cli: true, daemon: false, colima: false, desktop: false, brew: true },
      ok: (p) => /colima/.test(p.action) && p.action !== "recover",
    },
    {
      tid: "CLI + Docker Desktop → recover",
      facts: { platform: "darwin", cli: true, daemon: false, desktop: true },
      ok: (p) => p.action === "recover",
    },
    {
      tid: "CLI + Colima → recover",
      facts: { platform: "darwin", cli: true, daemon: false, colima: true },
      ok: (p) => p.action === "recover",
    },
    {
      tid: "running daemon → noop",
      facts: { platform: "darwin", cli: true, daemon: true },
      ok: (p) => p.action === "noop",
    },
    {
      tid: "linux bare → engine-get-docker",
      facts: { platform: "linux", cli: false, daemon: false },
      ok: (p) => p.action === "engine-get-docker",
    },
    {
      tid: "windows bare + winget → winget-desktop",
      facts: { platform: "win32", cli: false, daemon: false, winget: true },
      ok: (p) => p.action === "winget-desktop",
    },
  ];
  for (const c of cases) {
    try {
      const plan = m.planDockerInstall(c.facts);
      report.check(c.ok(plan), c.tid, "docker", null, JSON.stringify(plan));
    } catch (e) {
      report.record(c.tid, "docker", "FAIL", null, String(e?.message || e));
    }
  }

  // resolveDockerHost must return a string (real socket / context "")
  try {
    const rh = m.resolveDockerHost();
    report.check(typeof rh === "string", "resolveDockerHost returns sane host", "docker", null, rh || "(active context)");
  } catch (e) {
    report.record("resolveDockerHost returns sane host", "docker", "FAIL", null, String(e?.message || e));
  }
}
