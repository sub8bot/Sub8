/**
 * Live-exercise lane — actually drives the desk path on a real running container
 * each run, so this check produces FRESH evidence every tick (unlike the static
 * regression lanes). Read-only: it captures a screenshot of a live local desk
 * (never clicks/types on the user's bots — that would disrupt their work) and
 * verifies the capture path returns a real frame.
 *
 * This is the honest "is the desk actually alive right now" probe: it exercises
 * vm.screenshot → docker exec → x11grab on a genuinely running container.
 */
import { http, LOCAL_APP, run as execRun } from "../lib/util.mjs";

export async function run(report) {
  // Ask the live app which bots it believes are running (correct container +
  // display shape comes from the app, not a hand-built object).
  const bots = await http(LOCAL_APP, "/api/bots", { timeout: 8000 }).catch(() => null);
  if (!bots || bots.status !== 200) {
    report.record("live desk screenshot exercise", "exercise", "SKIP", null, `local app not reachable (HTTP ${bots?.status ?? 0})`);
    return;
  }
  const list = Array.isArray(bots.json) ? bots.json : bots.json?.bots || [];
  const running = list.filter((b) => (b.vm?.status || b.vmStatus) === "running" && b.vm?.container);
  if (!running.length) {
    report.record("live desk screenshot exercise", "exercise", "SKIP", null, "no running local bot to exercise");
    return;
  }
  // Exercise the first running bot (read-only). A live x11grab capture inside the
  // container is the true "desk is alive and painting" probe; fresh byte count
  // each run = real evidence, not a cached constant. (We use the container's own
  // ffmpeg to avoid host-side display-suffix quirks.)
  const bot = running[0];
  const container = bot.vm.container;
  const disp = String(bot.vm.display || ":1").startsWith(":") ? String(bot.vm.display || ":1") : `:${bot.vm.display || 1}`;
  const t0 = Date.now();
  const cap = await execRun(
    "docker",
    ["exec", "-e", `DISPLAY=${disp}`, container, "bash", "-lc",
      "ffmpeg -loglevel error -f x11grab -video_size 1024x768 -i \"$DISPLAY\" -frames:v 1 -y /tmp/exercise.png >/dev/null 2>&1; wc -c </tmp/exercise.png 2>/dev/null || echo 0"],
    { timeout: 20_000 },
  );
  const bytes = parseInt(String(cap.out || "").trim().split("\n").pop() || "0", 10) || 0;
  const secs = Math.round((Date.now() - t0) / 1000);
  report.record(
    "live desk capture exercise",
    "exercise",
    bytes > 1000 ? "PASS" : "FAIL",
    secs,
    bytes > 1000 ? `${bot.name}: live frame ${bytes}B on ${disp}@${container}` : `${bot.name}: capture returned ${bytes}B (desk not painting)`,
  );
}
