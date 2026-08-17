import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import * as vm from "./vm.mjs";
import * as routines from "./routines.mjs";
import { appRoot } from "./paths.mjs";
import { isHumanControl } from "./control.mjs";

const COMPUTER_ACTIONS = [
  "screenshot",
  "mouse_move",
  "left_click",
  "right_click",
  "double_click",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "wait",
  "clipboard_read",
  "clipboard_write",
  "open",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "send_message",
      description: "User-visible chat. Ack first, then result last.",
      parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "computer",
      description:
        "Drive the desktop. x,y are pixels on the LAST screenshot (origin top-left, 1:1 with the full 1024x768 image). Click the visual CENTER of a control you can see. After type, click the primary button (Send/Save/Search/OK/Post), then screenshot to verify. Scroll if the control is off-screen. The pointer is drawn on the image.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: COMPUTER_ACTIONS },
          x: { type: "number" },
          y: { type: "number" },
          x2: { type: "number", description: "Drag end x" },
          y2: { type: "number", description: "Drag end y" },
          text: { type: "string", description: "Typed text, or a URL for action=open" },
          keys: { type: "string" },
          dy: { type: "number" },
          dx: { type: "number" },
          ms: { type: "number" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a command on your computer.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_routine",
      description:
        "Create or UPDATE the standing routine. Default: rewrite the existing General/primary routine (pass id from list_routines). Only set force_new true if the user asked for a second job. instruction must be a standing brief (identity, mission, /config paths, next checkpoint), never the user's raw chat message.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing routine id to update" },
          name: { type: "string" },
          instruction: { type: "string" },
          interval_minutes: { type: "number" },
          group_key: { type: "string", description: "general unless user asked for a separate job" },
          force_new: { type: "boolean" },
          solo: { type: "boolean", description: "default true: drop other routines so only this one remains" },
          replace: { type: "boolean", description: "default true: replace instruction instead of appending" },
          enabled: { type: "boolean" },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_routines",
      description: "List standing routines.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "disable_routine",
      description: "Turn off a routine by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web via SpaceXAI. Use for news, facts, and flights (e.g. SFO to DCA). Do not open Chrome just to search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

export function isChatQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^(stop|halt|cancel|never mind)\b/i.test(t)) return false;
  if (/\b(go )?(post|tweet|publish) (it|now|this)\b/i.test(t)) return false;
  if (/\bwhy\b/i.test(t)) return true;
  if (/\b(answer|explain|you should)\b/i.test(t) && !/\bpost it\b/i.test(t)) return true;
  if (/^(what|how|when|where|who|did|do you|have you|are you|can you)\b/i.test(t)) return true;
  return /\?$/.test(t);
}

export async function orchestratorReply({ bot, settings, userText }) {
  const harness = resolveClient(settings);
  if (harness.kind !== "openai") return null;
  const isStatus = (t) =>
    /what are you (doing|working)|status\??$|still (working|there)\??/i.test(String(t || "").trim());
  const lastTask = [...(bot.messages || [])]
    .reverse()
    .find(
      (m) =>
        m.role === "user" &&
        !m.hidden &&
        !isStatus(m.content) &&
        String(m.content || "").trim() !== String(userText || "").trim() &&
        !isChatQuestion(m.content),
    );
  const work = (bot.messages || [])
    .filter((m) => m.kind === "tool")
    .slice(-16)
    .map((m) => m.summary || m.action || m.name)
    .filter(Boolean)
    .join("; ");
  const resp = await harness.client.chat.completions.create({
    model: harness.model,
    messages: [
      {
        role: "system",
        content: `You are ${bot.name}. First person only: I, me, my. Never say worker or orchestrator. Answer the user's actual question from the action list. If they ask why work is unfinished, be specific (typed a draft then clicked the text instead of Post; missed the Reply button by a few pixels; opened another tab). Do not use a canned line.`,
      },
      {
        role: "user",
        content: `Standing job:\n${String(lastTask?.content || "the current computer work").slice(0, 400)}\n\nWhat I actually did on the computer:\n${work || "nothing logged yet"}\n\nUser:\n${userText}`,
      },
    ],
    max_tokens: 180,
  });
  let text = String(resp.choices?.[0]?.message?.content || "").trim();
  if (/\bworker\b|\borchestrator\b/i.test(text)) {
    text = text
      .replace(/\b[Tt]he worker\b/g, "I")
      .replace(/\b[Ww]orker\b/g, "I")
      .replace(/\bit's\b/g, "I'm")
      .replace(/\bit is\b/g, "I am")
      .replace(/\bit typed\b/gi, "I typed")
      .replace(/\bit\b(?= (is|was|has|clicked|typed|started))/gi, "I");
  }
  return text || null;
}

export function resolveClient(settings) {
  const h = settings.harness || {};
  const key = (h.apiKey && h.apiKey.trim()) || process.env[h.apiKeyEnv || "XAI_API_KEY"] || process.env.XAI_API_KEY;
  if ((h.provider || "spacexai") === "grok-build") {
    if (key) {
      return {
        kind: "openai",
        grokBuild: true,
        model: h.model || "grok-4.6",
        provider: "grok-build",
        baseUrl: h.baseUrl || "https://api.x.ai/v1",
        client: new OpenAI({ apiKey: key, baseURL: h.baseUrl || "https://api.x.ai/v1" }),
      };
    }
    return { kind: "grok-build", command: h.grokBuildCommand || "grok", model: h.model || "grok-4.6" };
  }
  if (!key) throw new Error("No API key. Set XAI_API_KEY or paste a key in Settings → Harness.");
  return {
    kind: "openai",
    model: h.model || "grok-4.6",
    provider: h.provider || "spacexai",
    baseUrl: h.baseUrl || "https://api.x.ai/v1",
    client: new OpenAI({ apiKey: key, baseURL: h.baseUrl || "https://api.x.ai/v1" }),
  };
}

/** Cheap live check that the configured harness (default SpaceXAI) answers. */
export async function pingHarness(settings) {
  const harness = resolveClient(settings);
  const provider = settings.harness?.provider || "spacexai";
  if (harness.kind === "grok-build") {
    const ps = await vm.docker(["ps", "--format", "{{.Names}}", "--filter", "name=localbot-"]);
    const box = (ps.out || "").split("\n").map((s) => s.trim()).find(Boolean);
    if (!box) {
      return {
        ok: false,
        provider: "grok-build",
        kind: "grok-build",
        model: harness.model,
        error: "Grok Build only runs inside a bot computer, never on this Mac. Start a bot first.",
      };
    }
    const sample = await runGrokBuild(harness, "Reply with only the word PONG.", undefined, { vm: { container: box } });
    return {
      ok: /pong/i.test(sample),
      provider: "grok-build",
      kind: "grok-build",
      model: harness.model,
      command: harness.command,
      container: box,
      sample: (sample || "").slice(0, 240),
    };
  }
  const resp = await harness.client.chat.completions.create({
    model: harness.model,
    messages: [
      { role: "system", content: "Reply with only the word PONG." },
      { role: "user", content: "ping" },
    ],
    max_tokens: 8,
  });
  const sample = (resp.choices?.[0]?.message?.content || "").trim();
  return {
    ok: /pong/i.test(sample),
    provider,
    kind: harness.kind,
    model: harness.model,
    baseUrl: harness.baseUrl,
    sample,
  };
}

async function loadSystemPrompt(bot) {
  const adapter = await fs.readFile(path.join(appRoot, "prompts", "local-adapter.txt"), "utf8");
  const computer = await fs.readFile(path.join(appRoot, "prompts", "computer-control.txt"), "utf8");
  const core = await fs.readFile(path.join(appRoot, "prompts", "grok-bot-system.txt"), "utf8");
  const extra = bot.instructions?.trim() ? `\n\n## Standing instructions for this Bot\n${bot.instructions.trim()}\n` : "";
  const ident = `\nYou are the Bot named "${bot.name}". ${bot.description || ""}\n`;
  return `${adapter}\n${computer}\n${ident}${extra}${routines.promptBlock(bot)}\n${core}

## Sub8 override (this wins)
You already know the machine. Do not spend the first turns on \`pwd\`, \`whoami\`, \`ls /home\`, or hunting /workspace.
After send_message, if the user asked for something on the desktop (research, Chrome, files they can see, clicks): call \`computer\` screenshot next, then click like a human.
Use \`shell\` only for a concrete command you already know belongs on this computer (write a file under /config, run a known binary). Never explore the filesystem to "discover" where you are.
web_search is available for facts. Prefer it over opening Google unless the user asked to use the browser.
Routines: ONE standing job. "Run" / "resume" means execute, not rewrite. "Update" means append a rule to the existing brief, never replace a long brief with the chat line. Never delete the only routine unless they said delete.
If a submit already landed or the UI is still loading, do not submit the same thing again. If a click fails twice, stop repeating it.
`;
}

export function publicBot(bot) {
  return {
    ...bot,
    messages: (bot.messages || []).map((m) => ({ ...m, imagePath: undefined, imageB64: undefined })),
    routines: bot.routines || [],
  };
}

const AUTO_SHOT = new Set([
  "left_click",
  "right_click",
  "double_click",
  "left_click_drag",
  "type",
  "key",
  "scroll",
]);

export async function runTurn({ bot, settings, userText, emit, hidden = false, images = [], signal, pullNudges } = {}) {
  if (!Array.isArray(bot.routines)) bot.routines = [];
  if (!hidden && routines.looksLikeSchedule(userText)) {
    const parsed = routines.parseSchedule(userText);
    const { routine, merged } = routines.upsertRoutine(bot, {
      instruction: userText,
      intervalMs: parsed.intervalMs,
    });
    await Promise.resolve(emit("routine", { routine, merged }));
  }

  const harness = resolveClient(settings);
  const system = await loadSystemPrompt(bot);

  if (!hidden) {
    bot.messages.push({ id: `u${Date.now()}`, role: "user", content: userText, ts: Date.now() });
    emit("message", bot.messages.at(-1));
  } else {
    bot.messages.push({
      id: `u${Date.now()}`,
      role: "user",
      content: `[routine] ${userText}`,
      ts: Date.now(),
      hidden: true,
    });
    emit("message", bot.messages.at(-1));
  }

  const history = [
    { role: "system", content: system },
    ...bot.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .filter((m) => m.kind !== "activity" && m.kind !== "think")
      .slice(-30)
      .map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        return { role: m.role === "user" || m.role === "assistant" ? m.role : "user", content: m.content };
      }),
  ];
  if (images.length) {
    history.push({
      role: "user",
      content: [
        { type: "text", text: "Demonstration screenshots, in order:" },
        ...images.slice(0, 12).map((raw) => ({
          type: "image_url",
          image_url: { url: String(raw).startsWith("data:") ? raw : `data:image/png;base64,${raw}` },
        })),
      ],
    });
  }

  if (harness.kind === "grok-build") {
    if (!bot.grokSessionId) bot.grokSessionId = bot.id;
    const desktop = looksLikeDesktopTask(userText);
    const grokText = desktop
      ? `${userText}\n\nUse the desktop this turn. To open Chrome: nohup /usr/local/bin/chrome-desktop 'https://…' >/tmp/chrome.log 2>&1 &\nThen look at the screen. Do not only send a text plan.`
      : userText;
    emit("tool", { name: "computer", args: { action: "screenshot" } });
    const work = {
      id: `tl${Date.now()}gb`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Working on the computer",
      ts: Date.now(),
    };
    bot.messages.push(work);
    emit("message", work);
    const text = await runGrokBuild(harness, grokText, signal, bot);
    const msg = { id: `a${Date.now()}`, role: "assistant", content: text, ts: Date.now() };
    bot.messages.push(msg);
    emit("message", msg);
    if (desktop && bot.vm?.status === "running") {
      try {
        await computerAction(bot, { action: "screenshot" }, emit);
        const shotNote = {
          id: `tl${Date.now()}sh`,
          role: "activity",
          kind: "tool",
          name: "computer",
          action: "screenshot",
          summary: "Looked at the screen",
          ts: Date.now(),
        };
        bot.messages.push(shotNote);
        emit("message", shotNote);
      } catch (err) {
        const fail = {
          id: `e${Date.now()}`,
          role: "assistant",
          content: `Computer action failed: ${err.message}`,
          ts: Date.now(),
        };
        bot.messages.push(fail);
        emit("message", fail);
      }
    }
    return bot;
  }

  let steps = 0;
  let usedComputer = false;
  let lastVisible = "";
  const maxSteps = 32;

  const stopped = () => Boolean(signal?.aborted);
  while (steps++ < maxSteps) {
    if (stopped()) {
      const out = { id: `a${Date.now()}`, role: "assistant", content: "Stopped.", ts: Date.now() };
      bot.messages.push(out);
      emit("message", out);
      return bot;
    }
    if (isHumanControl(bot.id)) {
      const out = {
        id: `a${Date.now()}`,
        role: "assistant",
        content: "You've got the computer. I'll wait.",
        ts: Date.now(),
      };
      bot.messages.push(out);
      emit("message", out);
      return bot;
    }
    const incoming = typeof pullNudges === "function" ? pullNudges() : [];
    if (incoming.length) {
      for (const t of incoming) {
        history.push({ role: "user", content: t });
        /* already persisted by the chat orchestrator path */
      }
      history.push({
        role: "user",
        content: incoming.some((t) => isChatQuestion(t))
          ? "The user asked a question in chat. It was already answered there in first person. Do NOT treat that question as a new computer task. Do not start posting or change what you are doing unless they explicitly said to post/do it now."
          : "The user sent a chat message while you were working. It was already answered in chat. If they asked to stop or change course, follow that. If they asked you to do the thing now, do it. Otherwise continue the same computer work.",
      });
    }
    const resp = await harness.client.chat.completions.create(
      {
        model: harness.model,
        messages: history,
        tools: TOOLS,
        tool_choice: "auto",
      },
      signal ? { signal } : undefined,
    );
    const msg = resp.choices?.[0]?.message;
    if (!msg) break;

    if (msg.content && msg.content.trim() && !msg.tool_calls?.length) {
      const think = String(msg.reasoning_content || msg.reasoning || "").trim();
      emitThink(bot, emit, think, { hidden });
      lastVisible = msg.content.trim();
      const out = { id: `a${Date.now()}`, role: "assistant", content: lastVisible, ts: Date.now() };
      bot.messages.push(out);
      emit("message", out);
      if (usedComputer && steps < maxSteps - 1 && !isDone(lastVisible)) {
        history.push({ role: "assistant", content: lastVisible });
        history.push({
          role: "user",
          content: "Continue the same task until it is actually finished. Screenshot if you need to see the desktop. Do not stop at a plan.",
        });
        usedComputer = false;
        continue;
      }
      if (!usedComputer && looksLikeDesktopTask(userText) && steps < maxSteps - 1) {
        history.push({ role: "assistant", content: lastVisible });
        history.push({
          role: "user",
          content:
            "Do the desktop work now. Call computer action screenshot, then computer action open (text = URL) or click. Do not only describe the plan.",
        });
        continue;
      }
      break;
    }

    if (!msg.tool_calls?.length) break;

    const think = String(msg.reasoning_content || msg.reasoning || "").trim()
      || (msg.content && String(msg.content).trim())
      || "";
    emitThink(bot, emit, think, { hidden });

    history.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      if (stopped()) {
        const out = { id: `a${Date.now()}`, role: "assistant", content: "Stopped.", ts: Date.now() };
        bot.messages.push(out);
        emit("message", out);
        return bot;
      }
      const name = call.function.name;
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      emit("tool", { name, args });
      if (name === "computer") usedComputer = true;
      const result = await execTool(bot, name, args, emit, settings);
      if (name !== "send_message") {
        const activity = {
          id: `tl${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
          role: "activity",
          kind: "tool",
          name,
          action: name === "computer" ? args.action : name,
          summary: toolSummary(name, args, result.text),
          ts: Date.now(),
        };
        bot.messages.push(activity);
        emit("message", activity);
      }
      history.push({ role: "tool", tool_call_id: call.id, content: result.text });
      if (result.imageB64) {
        history.push({
          role: "user",
          content: [
            { type: "text", text: result.caption || "Screenshot. Coordinates are 1:1 with this image, origin top-left." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${result.imageB64}` } },
          ],
        });
      }
    }
  }
  return bot;
}

function toolSummary(name, args = {}, result = "") {
  if (name === "computer") {
    const a = args.action || "computer";
    if (a === "screenshot") return "Looked at the screen";
    if (a === "left_click") return "Clicked";
    if (a === "right_click") return "Right-clicked";
    if (a === "double_click") return "Double-clicked";
    if (a === "mouse_move") return "Moved the pointer";
    if (a === "left_click_drag") return "Dragged";
    if (a === "type") {
      const t = String(args.text || "").replace(/\s+/g, " ").trim();
      return t ? `Typed “${t.slice(0, 48)}${t.length > 48 ? "…" : ""}”` : "Typed";
    }
    if (a === "key") return args.keys ? `Pressed ${args.keys}` : "Pressed a key";
    if (a === "scroll") return "Scrolled";
    if (a === "wait") return "Waited";
    if (a === "clipboard_read") return "Read the clipboard";
    if (a === "clipboard_write") return "Copied to the clipboard";
    if (a === "open") return args.text ? `Opened ${String(args.text).slice(0, 48)}` : "Opened Chrome";
    return "Used the computer";
  }
  if (name === "web_search") {
    const q = String(args.query || "").trim();
    return q ? `Searched “${q.slice(0, 56)}${q.length > 56 ? "…" : ""}”` : "Searched the web";
  }
  if (name === "shell") {
    const c = String(args.command || "").trim();
    return c ? `Ran ${c.slice(0, 48)}${c.length > 48 ? "…" : ""}` : "Ran a command";
  }
  if (name === "upsert_routine") return args.name ? `Set up “${args.name}”` : "Updated a routine";
  if (name === "list_routines") return "Checked routines";
  if (name === "disable_routine") return "Paused a routine";
  if (result && /^error:/i.test(result)) return result.slice(0, 80);
  return name.replaceAll("_", " ");
}

function isDone(text) {
  return /\b(done|finished|all set|that's it|thats it|completed|closed the loop|nothing else|task is complete)\b/i.test(
    text || ""
  );
}

function looksLikeDesktopTask(text) {
  return /\b(chrome|browser|click|desktop|computer|screenshot|flight|google|open |type |search|x\.com|twitter|post|tab)\b/i.test(
    String(text || ""),
  );
}

const lastThinkAt = new Map();

function emitThink(bot, emit, text, { hidden } = {}) {
  const think = String(text || "").trim();
  if (!think || hidden) return;
  const now = Date.now();
  if (now - (lastThinkAt.get(bot.id) || 0) < 12_000) return;
  lastThinkAt.set(bot.id, now);
  const thought = {
    id: `th${now}${Math.random().toString(36).slice(2, 5)}`,
    role: "activity",
    kind: "think",
    content: think,
    ts: now,
  };
  bot.messages.push(thought);
  emit("message", thought);
}

function waitForPaint() {
  return new Promise((r) => setTimeout(r, 1800));
}

async function shotPayload(bot, emit, note = "") {
  const shot = await vm.screenshot(bot);
  emit("screen", { url: `/api/bots/${bot.id}/screen?t=${Date.now()}`, width: shot.width, height: shot.height });
  const loc = await vm.mouseLocation(bot);
  const caption = `${note} Screenshot ${shot.width}x${shot.height}. Mouse pointer is at ${loc.x},${loc.y} (drawn on the image). Click the center of a control you can see on THIS image.`.trim();
  return { text: caption, imageB64: shot.buf.toString("base64"), caption, width: shot.width, height: shot.height };
}

async function execTool(bot, name, args, emit, settings) {
  try {
    const hostTools = new Set(["send_message", "upsert_routine", "list_routines", "disable_routine", "web_search"]);
    if (bot.vm?.status !== "running" && !hostTools.has(name)) {
      return { text: "Computer is not running yet." };
    }
    if (name === "send_message") {
      const out = {
        id: `a${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        role: "assistant",
        content: String(args.content || ""),
        ts: Date.now(),
      };
      bot.messages.push(out);
      emit("message", out);
      return { text: "sent" };
    }
    if (name === "list_routines") {
      return { text: JSON.stringify(bot.routines || [], null, 2) };
    }
    if (name === "disable_routine") {
      const r = (bot.routines || []).find((x) => x.id === args.id);
      if (!r) return { text: "routine not found" };
      r.enabled = false;
      r.updatedAt = Date.now();
      return { text: `disabled ${r.name}` };
    }
    if (name === "upsert_routine") {
      const minutes = Number(args.interval_minutes);
      const { routine, merged, rejected } = routines.upsertRoutine(bot, {
        id: args.id || undefined,
        name: args.name,
        instruction: args.instruction,
        intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
        groupKey: args.group_key || undefined,
        forceNew: args.force_new === true,
        solo: args.solo !== false,
        replace: args.replace !== false,
        enabled: args.enabled,
      });
      await Promise.resolve(emit("routine", { routine, merged, rejected }));
      if (rejected) {
        return { text: `Did not replace the standing brief. ${rejected}. Do the work instead of rewriting the cron.` };
      }
      return {
        text: merged
          ? `Merged into existing "${routine.name}" (${routine.groupKey}) every ${Math.round(routine.intervalMs / 60000)} min.`
          : `Created "${routine.name}" (${routine.groupKey}) every ${Math.round(routine.intervalMs / 60000)} min.`,
      };
    }
    if (name === "web_search") {
      return { text: await webSearch(settings, args.query) };
    }
    if (name === "shell") {
      const r = await vm.shell(bot, args.command);
      return { text: r.output || (r.ok ? "(ok)" : "(failed)") };
    }
    if (name === "computer") {
      if (isHumanControl(bot.id)) {
        return {
          text: "The human has the mouse. Do not click, type, or move. Wait or reply in chat.",
        };
      }
      return computerAction(bot, args, emit);
    }
    return { text: `unknown tool ${name}` };
  } catch (err) {
    return { text: `error: ${err.message}` };
  }
}

const lastShotAt = new Map();

async function computerAction(bot, args, emit) {
  const action = args.action;
  const needsAim = ["left_click", "right_click", "double_click", "left_click_drag", "scroll"].includes(action);
  if (needsAim && Date.now() - (lastShotAt.get(bot.id) || 0) > 6000) {
    await shotPayload(bot, emit, "Look first, then click.");
  }
  if (action === "screenshot") {
    const shot = await shotPayload(bot, emit);
    lastShotAt.set(bot.id, Date.now());
    return shot;
  }
  if (action === "open") {
    const opened = await vm.openChrome(bot, args.text || args.keys || "");
    await waitForPaint();
    const shot = await shotPayload(bot, emit, opened.text);
    lastShotAt.set(bot.id, Date.now());
    return shot;
  }
  if (action === "wait") {
    await vm.wait(args.ms || 800);
    return { text: `waited ${args.ms || 800}ms` };
  }
  if (action === "clipboard_read") return { text: (await vm.clipboardRead(bot)) || "(empty)" };
  if (action === "clipboard_write") {
    await vm.clipboardWrite(bot, args.text || "");
    return { text: "clipboard set" };
  }
  if (action === "mouse_move") {
    await vm.mouseMove(bot, args.x, args.y);
    const loc = await vm.mouseLocation(bot);
    return { text: `mouse ${loc.x},${loc.y}` };
  }
  if (action === "left_click") await vm.click(bot, args.x, args.y, 1, 1);
  else if (action === "right_click") await vm.click(bot, args.x, args.y, 3, 1);
  else if (action === "double_click") await vm.click(bot, args.x, args.y, 1, 2);
  else if (action === "left_click_drag") await vm.drag(bot, args.x, args.y, args.x2, args.y2);
  else if (action === "type") await vm.typeText(bot, args.text || "");
  else if (action === "key") await vm.key(bot, args.keys || args.text || "Return");
  else if (action === "scroll") await vm.scroll(bot, args.x, args.y, args.dy || 0, args.dx || 0);
  else return { text: `unknown computer action ${action}` };

  if (AUTO_SHOT.has(action)) {
    const note =
      action === "type"
        ? "After type. Click the CENTER of the primary button next (one box only — no second thread). Then screenshot. If it already posted or the page is still loading, do not submit again."
        : `After ${action}.`;
    const shot = await shotPayload(bot, emit, note);
    lastShotAt.set(bot.id, Date.now());
    return shot;
  }
  return { text: action };
}

export async function webSearch(settings, query) {
  const q = String(query || "").trim();
  if (!q) return "empty query";
  const h = settings?.harness || {};
  const key = (h.apiKey && h.apiKey.trim()) || process.env[h.apiKeyEnv || "XAI_API_KEY"] || process.env.XAI_API_KEY;
  if (!key) return "No API key for web_search.";
  const base = (h.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
  let res;
  try {
    res = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: h.model || "grok-4.6",
        input: [{ role: "user", content: q }],
        tools: [{ type: "web_search" }],
        // grok-4.6 default reasoning can sit past 90s; low effort still searches.
        reasoning: { effort: "low" },
      }),
      signal: AbortSignal.timeout(70_000),
    });
  } catch (err) {
    const name = err?.name || "Error";
    if (name === "TimeoutError" || name === "AbortError") {
      return "web_search failed (timeout): SpaceXAI web_search took too long. Try a narrower query.";
    }
    return `web_search failed: ${err.message || name}`;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error?.message || json.error || res.statusText;
    return `web_search failed (${res.status}): ${typeof err === "string" ? err : JSON.stringify(err)}`;
  }
  const text = extractResponseText(json);
  const cites = collectCitations(json);
  if (!text && !cites.length) return JSON.stringify(json).slice(0, 2000);
  return cites.length ? `${text}\n\nSources:\n${cites.map((c) => `- ${c}`).join("\n")}` : text;
}

function extractResponseText(json) {
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  const chunks = [];
  for (const item of json.output || []) {
    if (item?.type && item.type !== "message" && item.type !== "output_text") continue;
    if (typeof item?.text === "string") chunks.push(item.text);
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function collectCitations(json) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    const url = String(u || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  if (Array.isArray(json.citations)) json.citations.forEach(add);
  for (const item of json.output || []) {
    for (const part of item?.content || []) {
      for (const ann of part?.annotations || []) {
        if (ann?.url) add(ann.url);
      }
    }
  }
  return out.slice(0, 6);
}

function recapForGrok(bot) {
  return (bot.messages || [])
    .filter((m) => !m.hidden && (m.role === "user" || m.role === "assistant") && m.kind !== "think" && m.kind !== "tool")
    .slice(-16)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").slice(0, 800)}`)
    .join("\n");
}

async function grokSessionOnDisk(box, sessionId) {
  const r = await vm.docker([
    "exec",
    "-u",
    "abc",
    "-e",
    "HOME=/config",
    box,
    "bash",
    "-lc",
    `test -d /config/.grok/sessions/%2Fconfig/${sessionId} || test -d /config/.grok/sessions/${sessionId}`,
  ]);
  return r.ok;
}

function runGrokBuild(harness, userText, signal, bot) {
  const box = bot?.vm?.container || (bot?.id ? vm.containerName(bot.id) : "");
  if (!box) {
    return Promise.resolve(
      "Grok Build only runs inside the bot computer, never on this Mac. Start the computer first.",
    );
  }
  const sessionId = bot.grokSessionId || bot.id;
  bot.grokSessionId = sessionId;
  return (async () => {
    try {
      await vm.pushHostGrokAuth(box);
    } catch {
      /* still try */
    }
    const ident = `You are the Bot named "${bot.name}". ${bot.description || ""}`.trim();
    const extra = bot.instructions?.trim() ? `\nStanding instructions:\n${bot.instructions.trim()}` : "";
    await vm.installAgentsMd(box, `${ident}${extra}`);
    const rules = `${await fs.readFile(path.join(appRoot, "prompts", "grok-build-vm.txt"), "utf8")}\n${ident}${extra}\n`;
    const exists = await grokSessionOnDisk(box, sessionId);
    const recap = recapForGrok(bot);
    const prompt = exists
      ? userText
      : recap
        ? `Continuing this Bot's conversation on my computer.\nPrior conversation:\n${recap}\n\nUser:\n${userText}`
        : userText;
    const grokArgs = ["-m", harness.model || "grok-4.6"];
    if (exists) grokArgs.push("--resume", sessionId);
    else grokArgs.push("--session-id", sessionId);
    grokArgs.push(
      "--single",
      prompt,
      "--permission-mode",
      "dontAsk",
      "--always-approve",
      "--rules",
      rules,
    );
    return new Promise((resolve) => {
      const inner = harness.command === "grok" || !harness.command ? "/usr/local/bin/grok" : harness.command;
      const args = [
        "exec",
        "-u",
        "abc",
        "-e",
        "HOME=/config",
        "-e",
        "DISPLAY=:1",
        "-e",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "-w",
        "/config",
        box,
        inner,
        ...grokArgs,
      ];
      const dockerEnv = { ...process.env };
      const host = vm.resolveDockerHost();
      if (host) dockerEnv.DOCKER_HOST = host;
      else delete dockerEnv.DOCKER_HOST;
      const child = spawn("docker", args, {
        env: dockerEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          if (!child.killed) child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(text);
      };
      const timer = setTimeout(() => finish("Grok Build timed out inside the computer."), 180_000);
      signal?.addEventListener("abort", () => finish("Stopped."));
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", (e) => finish(`Grok Build harness failed: ${e.message}`));
      child.on("close", () => finish(out.trim() || "(no output from grok)"));
    });
  })();
}
