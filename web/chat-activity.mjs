const GENERIC_WORKING = /^(working(?:\s+via\s+\S+)?|working on the computer)$/i;
function title(s) {
    const t = s.replaceAll("_", " ").trim();
    if (!t)
        return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
}
function actionLabel(name, action) {
    const n = name.toLowerCase();
    const a = action.toLowerCase();
    if (a === "screenshot")
        return "Looked at the screen";
    if (a === "open")
        return "Opened Chrome";
    if (a === "snapshot")
        return "Read the page";
    if (n === "browser") {
        if (a === "click")
            return "Browser click";
        if (a === "wait")
            return "Browser wait";
        if (a)
            return `Browser ${a}`;
    }
    if (a === "click" || a === "left_click")
        return "Clicked";
    if (a === "double_click")
        return "Double-clicked";
    if (a === "right_click")
        return "Right-clicked";
    if (a === "type")
        return "Typed";
    if (a === "key")
        return "Pressed a key";
    if (a === "scroll")
        return "Scrolled";
    if (a === "mouse_move")
        return "Moved the pointer";
    if (a === "wait")
        return "Waited";
    if (a === "shell" || n === "shell")
        return "Ran a command";
    return title(a) || title(n);
}
export function isActivityRow(m) {
    if (!m)
        return false;
    return m.kind === "think" || m.kind === "tool" || m.role === "activity";
}
export function isGenericWorkingLabel(s) {
    return GENERIC_WORKING.test(s.trim());
}
export function activityLabel(m) {
    if (!m)
        return "Starting…";
    const summary = String(m.summary || "").trim();
    const name = String(m.name || "").trim();
    const action = String(m.action || "").trim();
    if (summary && !isGenericWorkingLabel(summary))
        return summary;
    if (isGenericWorkingLabel(summary) && (action === "screenshot" || (!action && name === "computer"))) {
        return "Starting on the computer";
    }
    return actionLabel(name, action) || "Starting…";
}
export function lastActivity(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    for (let i = rows.length - 1; i >= 0; i--) {
        const m = rows[i];
        if (m && isActivityRow(m) && m.kind !== "think")
            return m;
    }
    return null;
}
export function liveBusyLabel(opts) {
    if (!opts.busy)
        return null;
    if (opts.liveTool)
        return activityLabel(opts.liveTool);
    const last = lastActivity(opts.messages);
    if (last)
        return activityLabel(last);
    return "Starting…";
}
export function isTurnClosingAssistant(m) {
    if (!m || m.role !== "assistant")
        return false;
    if (m.kind === "tool" || m.kind === "think" || m.kind === "choices" || m.kind === "secret-request")
        return false;
    const text = String(m.content || "").trim();
    if (!text)
        return false;
    if (/^Created \S+ on this desk to /i.test(text))
        return false;
    if (/^Created \S+ to /i.test(text))
        return false;
    if (/^To [^:]+: FIRST TASK/i.test(text))
        return false;
    if (/^Still working on my computer/i.test(text))
        return false;
    if (/^Got it\. I'll use that while I keep working/i.test(text))
        return false;
    return true;
}
export function applyChatBusy(bot, event) {
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
        if (event.name === "send_message")
            return bot;
        if (bot.serverBusy === false && !bot.clientTurn)
            return bot;
        bot.busy = true;
        bot.liveTool = { name: event.name, action: event.args?.action };
        return bot;
    }
    if (event.type === "message") {
        const msg = event.msg;
        if (isActivityRow(msg)) {
            bot.liveTool = msg;
            if (bot.clientTurn || bot.serverBusy !== false)
                bot.busy = true;
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
