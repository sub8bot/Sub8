#!/usr/bin/env node
/**
 * Host MCP for Claude / Codex. Tools only reach the bot Linux desktop, never this Mac.
 */
import * as store from "./store.mjs";
import * as vm from "./vm.mjs";
import * as vault from "./vault.mjs";
import * as routines from "./routines.mjs";
import * as teams from "./teams.mjs";
import { resolveZone } from "./context.mjs";
import * as memory from "./memory.mjs";

const botId = process.env.SUB8BOT_BOT_ID || "";
const token = process.env.SUB8_INTERNAL_TOKEN || "";
const emitUrl = process.env.SUB8_INTERNAL_URL || "";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function emit(event, data) {
  if (!emitUrl || !token || !botId) return;
  try {
    await fetch(`${emitUrl}/api/internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sub8-token": token },
      body: JSON.stringify({ botId, event, data }),
    });
  } catch {
    /* UI notify is best-effort */
  }
}

const TOOLS = [
  {
    name: "computer",
    description:
      "Drive the bot Linux desktop. Screenshot first. x,y are pixels on the last 1024x768 screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "left_click",
            "right_click",
            "double_click",
            "type",
            "key",
            "scroll",
            "wait",
            "open",
            "mouse_move",
          ],
        },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        keys: { type: "string" },
        dy: { type: "number" },
        dx: { type: "number" },
        ms: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside the bot Linux desktop (home /config). Files, apt, desk-doctor. Not the host Mac. Do not click, type, or drive Chrome from the shell.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "memory",
    description:
      "Read or write lasting notes on my computer under /config/agent-data and /config/workspace. Not HTTP. Use for durable facts and repeating-job history.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "append", "list"] },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "vault_list",
    description: "List saved logins this Bot may use. Never includes passwords.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_fill",
    description: "Paste a saved username or password into the focused desktop field. Never prints the secret.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        field: { type: "string", enum: ["username", "password"] },
      },
      required: ["account_id", "field"],
    },
  },
  {
    name: "list_routines",
    description: "List this Bot's standing routines (id, name, interval, instruction).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upsert_routine",
    description:
      "Create or UPDATE this Bot's standing routine. Pass id from list_routines to edit. The operator asking to change the routine is permission. Do not create a second job that overlaps (same group or similar interval); update the existing id. instruction must be the full standing brief. For every morning, pass schedule {type:\"daily\", hour:9, minute:0} and omit interval_minutes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        instruction: { type: "string" },
        interval_minutes: { type: "number" },
        schedule: {
          type: "object",
          properties: { type: { type: "string" }, hour: { type: "number" }, minute: { type: "number" } },
        },
        group_key: { type: "string" },
        force_new: { type: "boolean" },
        force_replace: { type: "boolean" },
        enabled: { type: "boolean" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "disable_routine",
    description: "Turn off a standing routine by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_teammates",
    description: "List the other Bots on your team (id, name, role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_teammate",
    description: "Assign work to another Bot on your shared desk. They get it in their own chat.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        content: { type: "string" },
      },
      required: ["bot_id", "content"],
    },
  },
  {
    name: "ask_user",
    description: "Show a multiple-choice card in chat. Wait for the human to pick.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        hint: { type: "string" },
        choices: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } },
        },
        allow_custom: { type: "boolean" },
      },
      required: ["question"],
    },
  },
  {
    name: "create_teammate",
    description: "Create another Bot in your group on the same shared desk. Optional harness, model, instructions, color. If job is missing, a choice card is shown first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        job: { type: "string" },
        role: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        instructions: { type: "string" },
        color: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_bot",
    description: "Rename yourself or a teammate.",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "string" }, name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "update_bot",
    description: "Change harness, model, instructions, description, color, or role for yourself or a teammate.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        name: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        instructions: { type: "string" },
        description: { type: "string" },
        color: { type: "string" },
        role: { type: "string" },
      },
    },
  },
  {
    name: "delete_teammate",
    description: "Remove a teammate from this group when asked.",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "string" } },
      required: ["bot_id"],
    },
  },
];

async function botOrThrow() {
  const bot = await store.getBot(botId);
  if (!bot) throw new Error("Bot not found");
  if (bot.vm?.status !== "running" || !bot.vm.container) throw new Error("Computer is not running yet.");
  return bot;
}

async function runComputer(args) {
  const bot = await botOrThrow();
  const action = args.action;
  await emit("tool", { name: "computer", args });
  if (action === "screenshot") {
    const shot = await vm.screenshot(bot);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Looked at the screen",
      ts: Date.now(),
    });
    return {
      content: [
        { type: "text", text: `Screenshot ${shot.width}x${shot.height}. Coordinates are 1:1, origin top-left.` },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "open") {
    await vm.openChrome(bot, args.text || "");
    await vm.wait(1200);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "open",
      summary: "Opened Chrome",
      ts: Date.now(),
    });
    const shot = await vm.screenshot(bot);
    return {
      content: [
        {
          type: "text",
          text: `Opened ${String(args.text || "Chrome").slice(0, 160)}. Screenshot ${shot.width}x${shot.height}. Click the next control or type.`,
        },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "left_click") await vm.click(bot, args.x, args.y, 1, 1);
  else if (action === "right_click") await vm.click(bot, args.x, args.y, 3, 1);
  else if (action === "double_click") await vm.click(bot, args.x, args.y, 1, 2);
  else if (action === "mouse_move") await vm.mouseMove(bot, args.x, args.y);
  else if (action === "type") await vm.typeText(bot, args.text || "");
  else if (action === "key") await vm.key(bot, args.keys || args.text || "Return");
  else if (action === "scroll") await vm.scroll(bot, args.x, args.y, args.dy || 0, args.dx || 0);
  else if (action === "wait") await vm.wait(args.ms || 800);
  else throw new Error(`unknown action ${action}`);
  await emit("message", {
    id: `tl${Date.now()}mcp`,
    role: "activity",
    kind: "tool",
    name: "computer",
    action,
    summary: action === "open" ? "Opened Chrome" : action.replaceAll("_", " "),
    ts: Date.now(),
  });
  return { content: [{ type: "text", text: `${action} ok` }] };
}

async function callTool(name, args = {}) {
  if (name === "computer") return runComputer(args);
  if (name === "shell") {
    const bot = await botOrThrow();
    const secrets = await vault.listSecrets();
    const cmd = String(args.command || "");
    if (secrets.some((s) => s && cmd.includes(s))) {
      return { content: [{ type: "text", text: "Blocked: do not put vault secrets in the shell." }], isError: true };
    }
    await emit("message", {
      id: `tl${Date.now()}sh`,
      role: "activity",
      kind: "tool",
      name: "shell",
      action: "shell",
      summary: `Ran ${cmd.slice(0, 48)}`,
      ts: Date.now(),
    });
    const r = await vm.shell(bot, cmd);
    return { content: [{ type: "text", text: vault.redactSecrets(r.output || (r.ok ? "(ok)" : "(failed)"), secrets) }] };
  }
  if (name === "memory") {
    const bot = await botOrThrow();
    const r = await memory.handleMemory(bot, args);
    await emit("message", {
      id: `tl${Date.now()}mem`,
      role: "activity",
      kind: "tool",
      name: "memory",
      action: String(args.action || "read"),
      summary: args.action === "append" ? "Noted memory" : args.action === "write" ? "Updated memory" : "Read memory",
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: r.text }], isError: r.ok === false };
  }
  if (name === "vault_list") {
    const rows = await vault.grantedAccounts(botId);
    return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No saved logins granted." }] };
  }
  if (name === "vault_fill") {
    const bot = await botOrThrow();
    const filled = await vault.fillIntoDesktop(bot, args.account_id, args.field || "password");
    await emit("message", {
      id: `tl${Date.now()}vf`,
      role: "activity",
      kind: "tool",
      name: "vault_fill",
      action: "vault_fill",
      summary: args.field === "username" ? "Pasted username" : "Pasted password",
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: filled.text }], isError: !filled.ok };
  }
  if (name === "list_routines") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const rows = bot.routines || [];
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "list_routines",
      action: "list_routines",
      summary: "Checked routines",
      ts: Date.now(),
    });
    return {
      content: [
        {
          type: "text",
          text: rows.length ? JSON.stringify(rows, null, 2) : "No standing routines.",
        },
      ],
    };
  }
  if (name === "disable_routine") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const r = (bot.routines || []).find((x) => x.id === args.id);
    if (!r) return { content: [{ type: "text", text: "routine not found" }], isError: true };
    r.enabled = false;
    r.updatedAt = Date.now();
    await store.upsertBot(bot);
    await emit("routine", { routine: r });
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "disable_routine",
      action: "disable_routine",
      summary: `Paused ${r.name}`,
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: `disabled ${r.name}` }] };
  }
  if (name === "upsert_routine") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const minutes = Number(args.interval_minutes);
    const instruction = String(args.instruction || "");
    const settings = await store.loadSettings();
    const { routine, merged, rejected } = routines.upsertRoutine(bot, {
      id: args.id || undefined,
      name: args.name,
      instruction,
      intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
      schedule: args.schedule,
      groupKey: args.group_key || undefined,
      forceNew: args.force_new === true,
      forceReplace: args.force_replace === true || instruction.length > 80,
      solo: args.solo !== false,
      replace: args.replace !== false,
      enabled: args.enabled,
      timeZone: resolveZone(settings),
    });
    await store.upsertBot(bot);
    await emit("routine", { routine, merged, rejected });
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "upsert_routine",
      action: "upsert_routine",
      summary: rejected ? "Kept the standing brief" : merged ? `Updated ${routine?.name || "routine"}` : `Created ${routine?.name || "routine"}`,
      ts: Date.now(),
    });
    if (rejected) {
      return {
        content: [
          {
            type: "text",
            text: `Did not create a second job. ${rejected}. Call upsert_routine with that id to edit.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: merged
            ? `Updated "${routine.name}" (${routine.id}) ${routines.cadenceLabel(routine).toLowerCase()}.`
            : `Created "${routine.name}" (${routine.id}) ${routines.cadenceLabel(routine).toLowerCase()}.`,
        },
      ],
    };
  }
  if (name === "list_teammates") {
    const bot = await store.getBot(botId);
    if (!bot?.teamId) return { content: [{ type: "text", text: "You are not on a team." }] };
    const team = await teams.getTeam(bot.teamId);
    const mates = teams.membersOf(team, await store.loadBots()).filter((b) => b.id !== bot.id);
    return {
      content: [
        {
          type: "text",
          text: mates.length
            ? JSON.stringify(mates.map((b) => ({ id: b.id, name: b.name, role: b.teamRole || "member" })), null, 2)
            : "No teammates.",
        },
      ],
    };
  }
  if (name === "message_teammate") {
    const bot = await store.getBot(botId);
    if (!bot?.teamId) return { content: [{ type: "text", text: "You are not on a team." }], isError: true };
    const toId = String(args.bot_id || "");
    const content = String(args.content || "").trim();
    if (!content) return { content: [{ type: "text", text: "empty message" }], isError: true };
    const team = await teams.getTeam(bot.teamId);
    const mate = teams.membersOf(team, await store.loadBots()).find((b) => b.id === toId);
    if (!mate) return { content: [{ type: "text", text: "that id is not on your team" }], isError: true };
    const posted = await teams.appendMessage(bot.teamId, {
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      speakerRole: bot.teamRole || "",
      toId: mate.id,
      toName: mate.name,
      content,
    });
    await emit("team-message", { teamId: bot.teamId, ...posted });
    await emit("message", {
      id: posted.id,
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      content: `To ${mate.name}: ${content}`,
      ts: posted.ts,
    });
    if (emitUrl && token) {
      try {
        await fetch(`${emitUrl}/api/internal/team-dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-sub8-token": token },
          body: JSON.stringify({ fromId: bot.id, toId: mate.id, content }),
        });
      } catch {
        /* dispatch is best-effort */
      }
    }
    return { content: [{ type: "text", text: `sent to ${mate.name}` }] };
  }
  if (name === "ask_user") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const choices = Array.isArray(args.choices) && args.choices.length
      ? args.choices.map((c, i) => ({ id: String(c.id || String.fromCharCode(97 + i)), label: String(c.label || "").trim() })).filter((c) => c.label)
      : teams.BOT_JOB_CHOICES;
    const card = {
      id: `ch${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      role: "assistant",
      kind: "choices",
      content: String(args.question || "What should we do?"),
      hint: String(args.hint || ""),
      choices,
      allowCustom: args.allow_custom !== false,
      pending: true,
      speakerId: bot.id,
      speakerName: bot.name,
      ts: Date.now(),
    };
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      b.messages.push(card);
    });
    await emit("message", card);
    return { content: [{ type: "text", text: "asked the user; wait for their pick in chat" }] };
  }
  if (name === "create_teammate") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const job = String(args.job || "").trim();
    const nm = String(args.name || "").trim() || "Worker";
    if (!job) {
      const card = {
        id: `ch${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        role: "assistant",
        kind: "choices",
        content: "What should this one do?",
        hint: "Name + job is enough. You can also type your own.",
        choices: teams.BOT_JOB_CHOICES,
        allowCustom: true,
        pending: true,
        context: { intent: "create-teammate", name: nm },
        speakerId: bot.id,
        speakerName: bot.name,
        ts: Date.now(),
      };
      await store.patchBot(botId, (b) => {
        b.messages = b.messages || [];
        b.messages.push(card);
      });
      await emit("message", card);
      return { content: [{ type: "text", text: "asked the user what this Bot should do" }] };
    }
    let team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
    if (!team) {
      team = await teams.saveTeam({
        name: `${bot.name}'s team`,
        chiefId: bot.id,
        memberIds: [bot.id],
        computerId: bot.vm?.computerId || null,
      });
      bot.teamId = team.id;
      bot.teamRole = bot.teamRole || "chief";
      await store.upsertBot(bot);
    }
    const { bot: mate } = await teams.addMember(team, {
      name: nm,
      job,
      role: args.role === "chief" ? "chief" : "worker",
      harness: bot.harness,
    });
    const note = {
      id: `a${Date.now()}nb`,
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      content: `Created ${mate.name} on this desk to ${job}. They’re in the sidebar on this team.`,
      ts: Date.now(),
    };
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      b.messages.push(note);
      b.teamId = team.id;
      b.teamRole = b.teamRole || "chief";
    });
    await emit("message", note);
    await emit("teammate", { bot: { id: mate.id, name: mate.name, teamId: mate.teamId, teamRole: mate.teamRole, color: mate.color, harness: mate.harness, vm: mate.vm } });
    return { content: [{ type: "text", text: `created ${mate.name} (${mate.id})` }] };
  }
  if (name === "rename_bot" || name === "update_bot") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const targetId = String(args.bot_id || bot.id);
    const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
    const target = await store.getBot(targetId);
    if (!target) return { content: [{ type: "text", text: "bot not found" }], isError: true };
    if (target.id !== bot.id && (!team || !team.memberIds?.includes(target.id))) {
      return { content: [{ type: "text", text: "that Bot is not on your team" }], isError: true };
    }
    await teams.applyBotPatch(target, args);
    await emit("teammate", { bot: { id: target.id, name: target.name, teamId: target.teamId, teamRole: target.teamRole, color: target.color, harness: target.harness, vm: target.vm } });
    return { content: [{ type: "text", text: `updated ${target.name}` }] };
  }
  if (name === "delete_teammate") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const targetId = String(args.bot_id || "");
    if (!targetId || targetId === bot.id) {
      return { content: [{ type: "text", text: "pick a teammate id; you cannot delete yourself" }], isError: true };
    }
    const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
    if (!team || !team.memberIds?.includes(targetId)) {
      return { content: [{ type: "text", text: "that Bot is not on your team" }], isError: true };
    }
    const target = await store.getBot(targetId);
    const label = target?.name || targetId;
    if (emitUrl && token) {
      try {
        await fetch(`${emitUrl}/api/internal/team-dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-sub8-token": token },
          body: JSON.stringify({ stopId: targetId }),
        });
      } catch {
        /* ignore */
      }
    }
    await teams.removeMember(team, targetId);
    await store.deleteBot(targetId);
    await emit("teammate", { gone: targetId });
    return { content: [{ type: "text", text: `deleted ${label}` }] };
  }
  throw new Error(`unknown tool ${name}`);
}

function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: payload });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message || "error") } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sub8", version: "0.3.10" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/call") {
    try {
      const out = await callTool(params?.name, params?.arguments || {});
      result(id, out);
    } catch (err) {
      result(id, { content: [{ type: "text", text: err.message }], isError: true });
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || "";
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) fail(msg.id, err.message);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
