// The spend guard: pause routines when the user is away and over budget; nudge once; resume on activity.
import assert from "node:assert/strict";
import * as g from "../server/spend-guard.mjs";
let pass=0, fail=0; function t(n,f){try{f();pass++;console.log("PASS",n)}catch(e){fail++;console.log("FAIL",n,"-",e.message)}}
const MIN = 60_000;

t("present user → always fire, even over budget", () => {
  g.resetForTest({ maxFiresPerWindow: 3 }, 0);
  for (let i=0;i<10;i++){ const d=g.decide(i*1000); assert.equal(d.action,"fire"); g.noteFire(i*1000); }
});

t("away + over budget → nudge once, then pause", () => {
  g.resetForTest({ awayMs: 30*MIN, maxFiresPerWindow: 3, renudgeMs: 30*MIN }, 0);
  for (let i=0;i<3;i++) g.noteFire(1000+i); // 3 fires in-window
  const away = 40*MIN;
  const first = g.decide(away);
  assert.equal(first.action, "nudge", "first away-over-budget check nudges");
  assert.match(first.reason, /routine runs/);
  const second = g.decide(away+1000);
  assert.equal(second.action, "skip-paused", "after the nudge it stays paused, no double nudge");
  assert.equal(g.isPaused(), true);
});

t("user activity auto-resumes a guard pause", () => {
  g.resetForTest({ awayMs: 30*MIN, maxFiresPerWindow: 1 }, 0);
  g.noteFire(0);
  assert.equal(g.decide(40*MIN).action, "nudge");
  assert.equal(g.isPaused(), true);
  g.noteUserActivity(41*MIN); // they came back
  assert.equal(g.isPaused(), false);
  assert.equal(g.decide(41*MIN).action, "fire", "routines run again once they're back");
});

t("'Pause all' persists across activity until explicit resume", () => {
  g.resetForTest({}, 0);
  g.pauseByUser();
  assert.equal(g.isPaused(), true);
  g.noteUserActivity(MIN); // returning does NOT lift a manual pause
  assert.equal(g.isPaused(), true, "manual pause survives activity");
  assert.equal(g.decide(MIN).action, "skip-paused");
  g.resume(2*MIN);
  assert.equal(g.isPaused(), false);
  assert.equal(g.decide(2*MIN).action, "fire");
});

t("fires outside the window don't count toward the budget", () => {
  g.resetForTest({ windowMs: 60*MIN, awayMs: 30*MIN, maxFiresPerWindow: 2 }, 0);
  g.noteFire(0); g.noteFire(1000); // 2 old fires
  const now = 90*MIN; // window is 60m, so old fires expired
  assert.equal(g.firesInWindow(now), 0, "old fires aged out");
  assert.equal(g.decide(now).action, "fire", "budget resets as the window slides");
});

t("away but under budget → keep firing (no waste-pause on a quiet schedule)", () => {
  g.resetForTest({ awayMs: 30*MIN, maxFiresPerWindow: 12 }, 0);
  g.noteFire(0);
  assert.equal(g.decide(40*MIN).action, "fire", "one hourly routine while away is fine");
});

console.log(`\n${pass} passed, ${fail} failed`); if(fail) process.exit(1);
