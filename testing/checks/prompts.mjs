/**
 * Prompts lane — the shipped behavior rules must be present in the generated
 * cloud system prompt (sub8-cloud/src/desk-system-source.mjs), and the freeze
 * fix (intent nudges) must still be in the worker turn loop (brain.mjs).
 *
 * These are regression guards: the prompt is generated from prompts/*.txt, so a
 * regen that drops a rule would silently change agent behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { CLOUD } from "../lib/util.mjs";

export async function run(report) {
  const src = path.join(CLOUD, "src", "desk-system-source.mjs");
  let text = "";
  try {
    text = fs.readFileSync(src, "utf8");
  } catch {
    report.record("desk-system-source present", "prompts", "FAIL", null, "missing desk-system-source.mjs");
    return;
  }
  report.check(/DESK_SYSTEM/.test(text) && text.length > 2000, "desk-system-source present", "prompts", null, `${text.length} bytes`);

  const rules = [
    ["captcha: try it, don't bail", /Captcha — try it/i],
    ["chief: responsive orchestrator / delegate", /stay responsive, delegate|delegate the work|stay responsive/i],
    ["act, don't announce", /Act, don'?t announce/i],
    ["two computers boundary", /Two computers/i],
    ["never type a password", /Never type a password/i],
    ["close bots is delete_teammate, not a job", /Closing teammates/i],
    ["close-all uses all_workers or delete_teammate", /all_workers=true/],
    ["do not assign close-bots as a job", /Do NOT [`']?set_job/i],
  ];
  for (const [tid, re] of rules) report.check(re.test(text), tid, "prompts", null, re.test(text) ? "present" : "MISSING");

  try {
    const brain = fs.readFileSync(path.join(CLOUD, "src", "brain.mjs"), "utf8");
    const harnessOnly =
      !/async function runDeskTurn/.test(brain) && /NEED_HARNESS/.test(brain) && /turnFn: harnessTurn/.test(brain);
    report.check(harnessOnly, "desk turns are harness-only (no Worker loop)", "prompts", null, harnessOnly ? "present" : "MISSING");
  } catch {
    report.record("desk turns are harness-only (no Worker loop)", "prompts", "FAIL", null, "brain.mjs missing");
  }
}
