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
ok("clock says report times in user zone", /report times in America\/New_York/.test(ny));

const hide = clockBlock({ userTimeZoneOverride: "America/New_York" }, { hidden: true });
ok("routine fire is labeled", /scheduled routine fire/.test(hide));

const th = localeForZone("Asia/Bangkok");
ok("Bangkok is THB", th.currency === "THB");

const tokyo = localeForZone("Asia/Tokyo");
ok("Tokyo is JPY", tokyo.currency === "JPY");

ok("bad zone falls back", resolveZone({ userTimeZoneOverride: "Not/AZone" }) === "America/New_York");

const { readFileSync } = await import("node:fs");
const ctxSrc = readFileSync(new URL("../server/context.mjs", import.meta.url), "utf8");
ok("chief prompt forbids extra files", /invent extra files/.test(ctxSrc));
ok("prompt forces USD on Google", /curr=USD/.test(ctxSrc));

const adapter = readFileSync(new URL("../prompts/local-adapter.txt", import.meta.url), "utf8");
ok("local-adapter keeps ack first", /Ack first/.test(adapter) && /send_message/.test(adapter));
ok(
  "local-adapter: parent cloud_agent on this computer",
  /cloud_agent/.test(adapter) && /same \/config/.test(adapter) && /not a second machine/.test(adapter),
);
ok("local-adapter: parent is dispatcher", /parent dispatcher/.test(adapter) && /Task subagents/.test(adapter));
ok("local-adapter: first person, not worker/orchestrator", /First person/.test(adapter) && /orchestrator/.test(adapter));
ok("local-adapter: ack ≠ delivery", /Ack ≠ delivery/.test(adapter) && /last send_message is the result/.test(adapter));
ok("local-adapter: channel is a room, team is desk", /channel is a room/i.test(adapter) && /job bar/.test(adapter));
ok(
  "local-adapter: close all bots is delete_teammate, not a job",
  /Closing teammates/i.test(adapter) && /all_workers=true/.test(adapter) && /Do NOT [`']?set_job/.test(adapter),
);
ok("chief prompt: closing bots is delete_teammate", /delete_teammate/.test(ctxSrc));
ok("local-adapter: never second VM, never narrate box", /Never a second VM/.test(adapter) && /Never narrate "box"/.test(adapter));
ok("local-adapter does not call itself orchestrator as a role", !/\bI am (the )?orchestrator\b/i.test(adapter));
ok(
  "local-adapter: widget ends the turn",
  /type=widget/.test(adapter) && /ENDS the turn/.test(adapter) && /ask_user/.test(adapter) && /is an alias/.test(adapter),
);
ok(
  "local-adapter: secret-request never chat paste",
  /secret-request/.test(adapter) && /Never ask them to paste a token in chat/.test(adapter),
);

const caps = readFileSync(new URL("../prompts/capabilities.txt", import.meta.url), "utf8");
ok(
  "capabilities: parent cloud_agent on this computer",
  /cloud_agent/.test(caps) && /same \/config/.test(caps) && /not a second machine/.test(caps),
);
ok("capabilities: parent is dispatcher", /parent dispatcher/.test(caps) && /Task subagents/.test(caps));
ok("capabilities: channel is a room, team is desk", /channel is a room/i.test(caps) && /job bar/.test(caps));
ok("capabilities: never second VM, never narrate box", /Never a second VM/.test(caps) && /Never narrate "box"/.test(caps));
ok("capabilities: send_message ack then result", /send_message/.test(caps) && /ack first/.test(caps) && /Ack ≠ delivery/.test(caps));
ok("capabilities: widget ends the turn", /type=widget/.test(caps) && /ENDS the turn/.test(caps));
ok("capabilities: secret-request not chat", /secret-request/.test(caps) && /never chat paste/.test(caps));

const control = readFileSync(new URL("../prompts/computer-control.txt", import.meta.url), "utf8");
ok("computer-control: never narrate box", /Never narrate "box"/.test(control) && /my computer/.test(control));
ok("computer-control keeps click rules", /Never invent coordinates/.test(control) && /browser` first/.test(control));

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`${failed.length} failed`);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} passed`);
