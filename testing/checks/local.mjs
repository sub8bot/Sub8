/**
 * Local lane — the desktop app on this machine.
 *
 *  - app health: /api/health, /api/ready reachable
 *  - docker status route: /api/docker reports a shape
 *  - drift reconcile: every bot the app reports "running" must map to a real
 *    `docker ps` container (name = localbot-<id8>). A running bot with no live
 *    container is stale UI state.
 *  - GUI-launch regression: docker detection must still work under a STRIPPED
 *    PATH subprocess (Finder-launched apps inherit /usr/bin:/bin:/usr/sbin:/sbin).
 *
 * If the app isn't running these record SKIP (not FAIL) so the 10-minute cron
 * doesn't flap when the desktop app is simply closed.
 *
 * Returns { runningDrift: [{botId, name, container}] } for the suite (no auto-heal
 * — local container drift is surfaced, not silently mutated).
 */
import path from "node:path";
import { http, LOCAL_APP, BOT, run as execRun, freshImport } from "../lib/util.mjs";

export async function run(report) {
  const out = { runningDrift: [] };

  const health = await http(LOCAL_APP, "/api/health", { timeout: 4000 });
  if (health.status !== 200) {
    report.record("local app reachable", "local", "SKIP", health.secs, `${LOCAL_APP} HTTP ${health.status}`);
    // still run the stripped-PATH docker regression — it doesn't need the app.
    await strippedPathDocker(report);
    return out;
  }
  report.record("local app health", "local", "PASS", health.secs, `${LOCAL_APP}`);

  const ready = await http(LOCAL_APP, "/api/ready", { timeout: 6000 });
  report.check(ready.status === 200 && ready.json && typeof ready.json.ok === "boolean", "local /api/ready responds", "local", ready.secs, `HTTP ${ready.status} ok=${ready.json?.ok}`);

  const docker = await http(LOCAL_APP, "/api/docker", { timeout: 8000 });
  const dockerOk = docker.status === 200 && docker.json?.docker && typeof docker.json.docker.ok === "boolean";
  report.check(dockerOk, "local /api/docker status shape", "local", docker.secs, dockerOk ? `ok=${docker.json.docker.ok}` : `HTTP ${docker.status}`);

  // ---- drift reconcile: running bots vs real containers ----
  try {
    const vm = await freshImport(path.join(BOT, "server", "vm.mjs"));
    const bots = await http(LOCAL_APP, "/api/bots", { timeout: 8000 });
    const list = (bots.json && Array.isArray(bots.json)) ? bots.json : [];
    const runningBots = list.filter((b) => (b.vm?.status || b.vmStatus) === "running");
    if (!(docker.json?.docker?.ok)) {
      report.record("running-bot ↔ container reconcile", "local", "SKIP", null, "docker daemon not up locally");
    } else {
      const states = await vm.listLocalbotStates({ force: true });
      for (const b of runningBots) {
        // A teammate shares the chief's container, so the real container is the
        // one the app reports (b.vm.container) — NOT one derived from this bot's
        // own id. Fall back to the derived name only if none is reported.
        const container = b.vm?.container || vm.containerName(b.id);
        const st = states.states.get(container);
        const live = Boolean(st && st.running);
        if (!live) out.runningDrift.push({ botId: b.id, name: b.name, container });
      }
      // Drift → the desk needs Recover/Reload, a gated action, so we FLAG it
      // (surfaced + logged) rather than FAIL — the cron stays green.
      report.record(
        "running-bot ↔ container reconcile",
        "local",
        out.runningDrift.length ? "FLAG" : "PASS",
        null,
        out.runningDrift.length
          ? `${out.runningDrift.length} running bot(s) with no live container: ${out.runningDrift.map((d) => d.container).join(", ")}`
          : `${runningBots.length} running bot(s) all map to containers`,
      );
    }
  } catch (e) {
    report.record("running-bot ↔ container reconcile", "local", "FAIL", null, String(e?.message || e));
  }

  await strippedPathDocker(report);
  return out;
}

/**
 * GUI-launch regression: with a Finder-style stripped PATH, the login-shell
 * fallback in vm.mjs must still locate a docker CLI. Runs in a subprocess so we
 * can control PATH without polluting our own env.
 */
async function strippedPathDocker(report) {
  const vm = path.join(BOT, "server", "vm.mjs");
  const script = `import(${JSON.stringify("file://" + vm)}).then(async m=>{const st=await m.dockerStatus();process.stdout.write(JSON.stringify({bin:m.dockerBin(),ok:st.ok,cli:st.cli}));}).catch(e=>process.stdout.write("ERR "+e.message));`;
  const r = await execRun(process.execPath, ["-e", script], {
    timeout: 30_000,
    env: { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  let j = {};
  try { j = JSON.parse(r.out); } catch {}
  const found = j.bin && String(j.bin).startsWith("/") && j.cli;
  report.check(Boolean(found), "docker found under stripped PATH (GUI-launch)", "local", r.secs, `bin=${j.bin || String(r.out).slice(0, 40)} cli=${j.cli}`);
}
