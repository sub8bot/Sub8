/** Pure helpers for team dispatch. Kept out of index.mjs so tests can import them. */

export function isFollowUpDispatch(messages = []) {
  return (messages || []).some(
    (m) => m?.speakerRole === "chief" && (m.role === "user" || m.role === "assistant"),
  );
}

export function storedChiefToWorker(who, text) {
  const name = String(who || "Chief").trim() || "Chief";
  return `${name}: ${String(text || "").trim()}`;
}

export function wrapWorkerDispatch({ who, role, text, followUp = false } = {}) {
  const name = String(who || "a teammate").trim() || "a teammate";
  const r = String(role || "teammate").trim() || "teammate";
  const body = String(text || "").trim();
  if (followUp) {
    return `${name} (${r}) sent a note. Use YOUR screen. Do not restart the search unless they said the last result was wrong or blocked.

${body}

If your step is already done, message_teammate ${name} one line and stop. Do not set update_task running again. Only update_task if status or detail actually changed. Then stop.`;
  }
  return `${name} (${r}) assigned you this. Use YOUR screen (your DISPLAY / Chrome), not theirs.

${body}

Start with update_task status=running. When finished: update_task status=done (or blocked) with a one-line detail, then message_teammate ${name} ONE short line. Do not write a long report to the chief. Long notes stay in your own chat. Web: browser navigate/snapshot/click. Then stop.`;
}

export function chiefReportStored(fromName, short) {
  const name = String(fromName || "Teammate").trim() || "Teammate";
  return `${name} replies: ${String(short || "").trim()}`;
}

export function chiefReportLlm(fromName, short) {
  return `${chiefReportStored(fromName, short)}

This is a teammate report, not a new job and not a routine. Do not upsert_routine. Do not invent extra files. Do not open Chrome or re-search unless they said failed/blocked. list_tasks. Compile from those details (latest) for EVERY non-Summary step, including any you did yourself. send_message that list, update_task Summary done, and stop.`;
}
