/** One activity or chat row, as the thread stores it. */
export type ChatActivityMsg = {
  role?: string | undefined;
  kind?: string | undefined;
  name?: string | undefined;
  action?: string | undefined;
  summary?: string | undefined;
  content?: string | undefined;
};

/** Client busy flags. `serverBusy` / `clientTurn` / `liveTool` stay in the browser. */
export type ChatBusyBot = {
  busy?: boolean | undefined;
  serverBusy?: boolean | undefined;
  clientTurn?: boolean | undefined;
  liveTool?: ChatActivityMsg | null | undefined;
};

export type ChatBusyEvent =
  | { type: "send" }
  | { type: "stop" }
  | { type: "error" }
  | { type: "bot"; busy?: boolean | undefined }
  | { type: "tool"; name?: string | undefined; args?: { action?: string | undefined } | undefined }
  | { type: "message"; msg?: ChatActivityMsg | undefined };

const GENERIC_WORKING = /^(working(?:\s+via\s+\S+)?|working on the computer)$/i;

function title(s: string): string {
  const t = s.replaceAll("_", " ").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The CLI harness reports MCP tools as `mcp__sub8__vault_fill` and its own as `ToolSearch`; strip that to the tool. */
export function toolKey(name: string): string {
  const raw = String(name || "").trim();
  const m = /^mcp__[a-z0-9_-]+?__(.+)$/i.exec(raw);
  return (m ? m[1]! : raw).toLowerCase();
}

/** Progressive labels for the sub8 tools (and the CLI's own), by tool key. */
const TOOL_LABELS: Record<string, string> = {
  vault_list: "Checking saved logins",
  vault_fill: "Pasting the password",
  show_user: "Sharing a screenshot",
  ask_user: "Asking you a question",
  request_box_help: "Asking you to take control",
  memory: "Checking my notes",
  list_tasks: "Checking my tasks",
  update_task: "Updating a task",
  set_job: "Setting the job",
  list_routines: "Checking routines",
  upsert_routine: "Saving a routine",
  disable_routine: "Pausing a routine",
  delete_routine: "Removing a routine",
  list_teammates: "Checking the team",
  create_teammate: "Bringing in a teammate",
  message_teammate: "Messaging a teammate",
  delete_teammate: "Closing a teammate",
  rename_bot: "Renaming",
  update_bot: "Updating my settings",
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  read: "Reading a file",
  await_shell: "Waiting on a command",
  task: "Starting a background task",
  check_subagent: "Checking a background task",
  create_channel: "Creating a channel",
  update_channel: "Updating a channel",
  nothing_to_add: "Nothing to add",
  toolsearch: "Picking tools",
  bash: "Running a command",
  websearch: "Searching the web",
  webfetch: "Reading a page",
};

function actionLabel(name: string, action: string): string {
  const n = toolKey(name);
  const a = action.toLowerCase();
  if (n === "vault_fill" && a === "username") return "Pasting the username";
  if (TOOL_LABELS[n] && n !== "computer" && n !== "browser" && n !== "shell") return TOOL_LABELS[n]!;
  if (a === "screenshot") return "Looked at the screen";
  if (a === "open") return "Opened Chrome";
  if (a === "snapshot") return "Read the page";
  if (n === "browser") {
    if (a === "click") return "Browser click";
    if (a === "wait") return "Browser wait";
    if (a) return `Browser ${a}`;
  }
  if (a === "click" || a === "left_click") return "Clicked";
  if (a === "double_click") return "Double-clicked";
  if (a === "right_click") return "Right-clicked";
  if (a === "type") return "Typed";
  if (a === "key") return "Pressed a key";
  if (a === "scroll") return "Scrolled";
  if (a === "mouse_move") return "Moved the pointer";
  if (a === "wait") return "Waited";
  if (a === "shell" || n === "shell") return "Ran a command";
  return title(a) || title(n.replace(/_/g, " "));
}

export function isActivityRow(m: ChatActivityMsg | null | undefined): boolean {
  if (!m) return false;
  return m.kind === "think" || m.kind === "tool" || m.role === "activity";
}

export function isGenericWorkingLabel(s: string): boolean {
  return GENERIC_WORKING.test(s.trim());
}

export function activityLabel(m: ChatActivityMsg | null | undefined): string {
  if (!m) return "Starting…";
  const summary = String(m.summary || "").trim();
  const name = String(m.name || "").trim();
  const action = String(m.action || "").trim();
  if (summary && !isGenericWorkingLabel(summary)) return summary;
  if (isGenericWorkingLabel(summary) && (action === "screenshot" || (!action && name === "computer"))) {
    return "Starting on the computer";
  }
  return actionLabel(name, action) || "Starting…";
}

export function lastActivity(messages: ChatActivityMsg[] | null | undefined): ChatActivityMsg | null {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m && isActivityRow(m) && m.kind !== "think") return m;
  }
  return null;
}

export function liveBusyLabel(opts: {
  busy?: boolean | undefined;
  messages?: ChatActivityMsg[] | null | undefined;
  liveTool?: ChatActivityMsg | null | undefined;
}): string | null {
  if (!opts.busy) return null;
  if (opts.liveTool) return activityLabel(opts.liveTool);
  const last = lastActivity(opts.messages);
  if (last) return activityLabel(last);
  return "Starting…";
}

export function isTurnClosingAssistant(m: ChatActivityMsg | null | undefined): boolean {
  if (!m || m.role !== "assistant") return false;
  if (m.kind === "tool" || m.kind === "think" || m.kind === "choices" || m.kind === "secret-request") return false;
  const text = String(m.content || "").trim();
  if (!text) return false;
  if (/^Created \S+ on this desk to /i.test(text)) return false;
  if (/^Created \S+ to /i.test(text)) return false;
  if (/^To [^:]+: FIRST TASK/i.test(text)) return false;
  if (/^Still working on my computer/i.test(text)) return false;
  if (/^Got it\. I'll use that while I keep working/i.test(text)) return false;
  return true;
}

export function applyChatBusy(bot: ChatBusyBot, event: ChatBusyEvent): ChatBusyBot {
  if (event.type === "send") {
    bot.clientTurn = true;
    bot.serverBusy = true;
    bot.busy = true;
    bot.liveTool = null;
    return bot;
  }
  if (event.type === "stop" || event.type === "error") {
    bot.clientTurn = false;
    bot.serverBusy = false;
    bot.busy = false;
    bot.liveTool = null;
    return bot;
  }
  if (event.type === "bot") {
    if (typeof event.busy === "boolean") {
      bot.serverBusy = event.busy;
      bot.busy = event.busy;
      if (!event.busy) {
        bot.clientTurn = false;
        bot.liveTool = null;
      }
    }
    return bot;
  }
  if (event.type === "tool") {
    if (event.name === "send_message") return bot;
    if (bot.serverBusy === false && !bot.clientTurn) return bot;
    bot.busy = true;
    bot.liveTool = { name: event.name, action: event.args?.action };
    return bot;
  }
  if (event.type === "message") {
    const msg = event.msg;
    if (isActivityRow(msg)) {
      bot.liveTool = msg;
      if (bot.clientTurn || bot.serverBusy !== false) bot.busy = true;
      return bot;
    }
    if (isTurnClosingAssistant(msg)) {
      bot.busy = false;
      bot.clientTurn = false;
      bot.liveTool = null;
    }
    return bot;
  }
  return bot;
}
