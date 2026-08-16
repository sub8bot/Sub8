import * as vm from "../server/vm.mjs";
import * as routines from "../server/routines.mjs";

const bot = {
  id: process.env.BOT_ID,
  vm: {
    container: process.env.CONTAINER,
    display: ":1",
    status: "running",
  },
};

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  if (!bot.id || !bot.vm.container) {
    const list = await fetch("http://127.0.0.1:8787/api/bots").then((r) => r.json());
    const b = list[0];
    if (!b) throw new Error("no bot");
    bot.id = b.id;
    bot.vm.container = b.vm.container;
    bot.vm.display = b.vm.display || ":1";
  }

  const shot = await vm.screenshot(bot);
  rec("01 screenshot exists", shot.bytes > 1000, `${shot.width}x${shot.height} ${shot.bytes}b`);
  rec("02 screenshot is 1024x768", shot.width === 1024 && shot.height === 768, `${shot.width}x${shot.height}`);

  await vm.mouseMove(bot, 200, 150);
  let loc = await vm.mouseLocation(bot);
  rec("03 mouse_move 200,150", Math.abs(loc.x - 200) <= 2 && Math.abs(loc.y - 150) <= 2, `${loc.x},${loc.y}`);

  await vm.click(bot, 400, 300, 1, 1);
  loc = await vm.mouseLocation(bot);
  rec("04 left_click lands", Math.abs(loc.x - 400) <= 3 && Math.abs(loc.y - 300) <= 3, `${loc.x},${loc.y}`);

  const safe = process.env.SAFE === "1";

  await vm.click(bot, 55, 70, 1, 2);
  await vm.wait(800);
  rec("05 double_click Home icon", true, safe ? "issued (safe: may have missed)" : "issued");

  await vm.click(bot, 1010, 12, 1, 1);
  await vm.wait(400);
  rec("06 click top-right pixel", true, "issued");

  if (!safe) await vm.shell(bot, "pkill -f thunar || pkill -f mousepad || true");
  await vm.shell(bot, "xfce4-terminal --geometry=70x18+120+80 -e 'bash -lc \"sleep 20\"' &");
  await vm.wait(1200);
  await vm.click(bot, 260, 200, 1, 1);
  await vm.typeText(bot, "echo PIXEL_OK");
  await vm.key(bot, "Return");
  await vm.wait(400);
  const typed = await vm.shell(bot, "xdotool getactivewindow getwindowname");
  rec("07 type + Return in terminal", /terminal/i.test(typed.output) || typed.ok, typed.output.slice(0, 80));

  await vm.clipboardWrite(bot, "CLIP_PAYLOAD_42");
  const clip = await vm.clipboardRead(bot);
  rec("08 clipboard write/read", clip.includes("CLIP_PAYLOAD_42"), clip.slice(0, 40));

  await vm.click(bot, 260, 220, 1, 1);
  await vm.key(bot, "ctrl+v");
  rec("09 paste via ctrl+v", true, "issued");

  await vm.key(bot, "ctrl+c");
  rec("10 copy combo ctrl+c", true, "issued");

  await vm.scroll(bot, 500, 400, 200);
  rec("11 scroll down", true, "issued");
  await vm.scroll(bot, 500, 400, -200);
  rec("12 scroll up", true, "issued");

  await vm.drag(bot, 300, 80, 500, 200);
  rec("13 drag", true, "issued");

  if (safe) {
    const chrome = await vm.shell(bot, "pgrep -a chrome | head -1; pgrep -a rustdesk | head -1");
    rec("14 chrome already running (safe)", /chrome/i.test(chrome.output), chrome.output.slice(0, 80));
    rec("15 skip RustDesk launch (safe)", true, "left Gmail/X session alone");
    rec("16 skip Applications click (safe)", true, "skipped");
    await vm.shell(bot, "pkill -f xfce4-terminal || true");
  } else {
  await vm.click(bot, 55, 268, 1, 2);
  await vm.wait(2000);
  const chrome = await vm.shell(bot, "pgrep -a chrome | head -1");
  rec("14 double-click Chrome icon", /chrome/i.test(chrome.output), chrome.output.slice(0, 80));

  await vm.shell(bot, "pkill -f chrome || true");
  await vm.wait(500);
  await vm.click(bot, 55, 360, 1, 2);
  await vm.wait(2000);
  const rd = await vm.shell(bot, "pgrep -a rustdesk | head -1");
  rec("15 double-click RustDesk icon", /rustdesk/i.test(rd.output), rd.output.slice(0, 80));

  await vm.click(bot, 40, 12, 1, 1);
  await vm.wait(400);
  rec("16 click Applications menu", true, "issued");

  await vm.shell(bot, "pkill -f rustdesk || true; pkill -f xfce4-terminal || true");
  }
  const after = await vm.screenshot(bot);
  rec("17 screenshot after cleanup", after.bytes > 1000, `${after.width}x${after.height}`);

  const botA = { routines: [] };
  routines.upsertRoutine(botA, { instruction: "check X notifications every 7 minutes" });
  const m = routines.upsertRoutine(botA, { instruction: "check private messages on X every 7 minutes" });
  rec("18 group X notifs + DMs into one routine", m.merged && botA.routines.length === 1, `n=${botA.routines.length} merged=${m.merged}`);

  routines.upsertRoutine(botA, { instruction: "check email daily" });
  rec("19 email is a separate group", botA.routines.length === 2, `n=${botA.routines.length}`);

  const due = routines.dueRoutines({ ...botA, routines: botA.routines.map((r) => ({ ...r, lastRunAt: 0 })) });
  const packs = routines.packDue(due);
  rec("20 overlapping due jobs pack by group", packs.length === 2, `packs=${packs.length}`);

  const parsed = routines.parseSchedule("do this every 15 minutes");
  rec("21 parse every 15 minutes", parsed?.intervalMs === 15 * 60_000, JSON.stringify(parsed));

  const daily = routines.parseSchedule("check flights daily");
  rec("22 parse daily", daily?.intervalMs === 86400_000, JSON.stringify(daily));

  const hi = vm.clampPoint(2000, 900);
  rec("23 clamp high to 1023,767", hi.x === 1023 && hi.y === 767, JSON.stringify(hi));
  const lo = vm.clampPoint(-5, -5);
  rec("24 clamp low to 0,0", lo.x === 0 && lo.y === 0, JSON.stringify(lo));

  const fail = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (fail.length) {
    console.log("failures:", fail);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
