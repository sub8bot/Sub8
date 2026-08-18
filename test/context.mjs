import { clockBlock, localeForZone, resolveZone } from "../server/context.mjs";

const checks = [];
function ok(name, cond) {
  checks.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

const ny = clockBlock({ userTimeZoneOverride: "America/New_York" });
ok("clock names America/New_York", ny.includes("America/New_York"));
ok("clock has currency USD", /Currency: USD/.test(ny));
ok("clock has today yyyy-mm-dd", /Today is \d{4}-\d{2}-\d{2}/.test(ny));
ok("clock has tomorrow", /Tomorrow is /.test(ny));

const hide = clockBlock({ userTimeZoneOverride: "America/New_York" }, { hidden: true });
ok("routine fire is labeled", /scheduled routine fire/.test(hide));

const th = localeForZone("Asia/Bangkok");
ok("Bangkok is THB", th.currency === "THB");

const tokyo = localeForZone("Asia/Tokyo");
ok("Tokyo is JPY", tokyo.currency === "JPY");

ok("bad zone falls back", resolveZone({ userTimeZoneOverride: "Not/AZone" }) === "America/New_York");

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`${failed.length} failed`);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} passed`);
