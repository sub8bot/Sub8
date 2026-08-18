import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import * as vm from "./vm.mjs";
import * as routines from "./routines.mjs";
import { appRoot } from "./paths.mjs";
import { isHumanControl } from "./control.mjs";
import * as vault from "./vault.mjs";
import * as hostCli from "./host-cli.mjs";
import { detectLocalHarnesses, localSpec } from "./local-llm.mjs";
import * as ctx from "./context.mjs";

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
        "Create or UPDATE a standing routine only when the user asked to keep doing a job on a clock (every N minutes, hourly, daily). instruction must be a standing brief (what to watch, cadence, next checkpoint), never 'check again' or the raw chat line. Default: update the existing routine (pass id from list_routines). Only set force_new true if they asked for a second job.",
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
  {
    type: "function",
    function: {
      name: "vault_list",
      description:
        "List saved logins this Bot is allowed to use. Returns label, site, username, and id only — never a password.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_fill",
      description:
        "Paste a saved username or password into the focused field on the desktop. Click the field first. Never prints the secret. Use field=username or field=password.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          field: { type: "string", enum: ["username", "password"] },
        },
        required: ["account_id", "field"],
      },
    },
  },
];

export function isChatQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^(stop|halt|cancel|never mind)\b/i.test(t)) return false;
  if (/\b(go )?(post|tweet|publish) (it|now|this)\b/i.test(t)) return false;
  if (/\b(open|click|type|go to|search|navigate|try again|resume|screenshot)\b/i.test(t)) return false;
  if (/^(can you|could you|would you|please)\b/i.test(t) && looksLikeDesktopTask(t)) return false;
  if (/\bwhy\b/i.test(t)) return true;
  if (/\b(answer|explain|you should)\b/i.test(t) && !/\bpost it\b/i.test(t)) return true;
  if (/^(what|how|when|where|who|did|do you|have you|are you)\b/i.test(t)) return true;
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

export const HARNESS_PROVIDERS = [
  { id: "grok-build", label: "Grok Build", kind: "cli-host" },
  { id: "hermes", label: "Hermes", kind: "cli-host" },
  { id: "claude", label: "Claude", kind: "cli-host" },
  { id: "codex", label: "Codex", kind: "cli-host" },
  { id: "ollama", label: "Ollama", kind: "openai-local" },
  { id: "lmstudio", label: "LM Studio", kind: "openai-local" },
  { id: "spacexai", label: "SpaceXAI", kind: "openai" },
];

export function normalizeProvider(p) {
  const id = String(p || "").trim();
  if (HARNESS_PROVIDERS.some((x) => x.id === id)) return id;
  return "grok-build";
}

export function harnessFor(bot, settings) {
  const global = settings?.harness || {};
  const local = bot?.harness || {};
  const provider = normalizeProvider(local.provider && local.provider !== "default" ? local.provider : global.provider);
  const model = (local.model && String(local.model).trim()) || (global.provider === provider ? global.model : "") || "";
  return { ...global, provider, model };
}

export function resolveClient(settings, bot) {
  const h = harnessFor(bot, settings);
  const key = (h.apiKey && h.apiKey.trim()) || process.env[h.apiKeyEnv || "XAI_API_KEY"] || process.env.XAI_API_KEY;
  if (h.provider === "claude" || h.provider === "codex" || h.provider === "hermes" || h.provider === "grok-build") {
    return { kind: "cli-host", provider: h.provider, model: h.provider === "grok-build" ? h.model || "grok-4.6" : h.model };
  }
  const local = localSpec(h.provider);
  if (local) {
    return {
      kind: "openai",
      provider: h.provider,
      model: h.model,
      baseUrl: h.baseUrl && !/api\.x\.ai/i.test(h.baseUrl) ? h.baseUrl : local.baseUrl,
      client: new OpenAI({
        apiKey: (h.apiKey && h.apiKey.trim()) || local.key,
        baseURL: h.baseUrl && !/api\.x\.ai/i.test(h.baseUrl) ? h.baseUrl : local.baseUrl,
      }),
    };
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
export async function pingHarness(settings, bot, providerOverride) {
  const prev = settings?.harness || {};
  const cli =
    providerOverride === "hermes" ||
    providerOverride === "claude" ||
    providerOverride === "codex" ||
    providerOverride === "grok-build";
  const forced = providerOverride
    ? {
        ...settings,
        harness: {
          ...prev,
          provider: providerOverride,
          // Do not leak the default Grok model onto Claude / Codex / Hermes.
          model: cli ? "" : providerOverride === prev.provider ? prev.model || "" : "",
        },
      }
    : settings;
  // A Settings tab test is about that engine, not the selected Bot's harness.
  const harness = resolveClient(forced, providerOverride ? null : bot);
  const provider = harness.provider || forced.harness?.provider || "spacexai";
  if (harness.kind === "cli-host") {
    const r = await hostCli.pingHostCli(harness.provider);
    return { ...r, provider: harness.provider, kind: "cli-host", model: harness.model };
  }
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
  if ((harness.provider === "ollama" || harness.provider === "lmstudio") && !harness.model) {
    const found = await detectLocalHarnesses();
    const models = found[harness.provider]?.models || [];
    if (!models.length) {
      return {
        ok: false,
        provider: harness.provider,
        kind: "openai",
        error: `${harness.provider === "lmstudio" ? "LM Studio" : "Ollama"} is not running or has no models loaded.`,
      };
    }
    harness.model = models[0];
  }
  const resp = await harness.client.chat.completions.create({
    model: harness.model,
    messages: [{ role: "user", content: "Reply with only the word PONG." }],
    max_tokens: 64,
  });
  const msg = resp.choices?.[0]?.message || {};
  const sample = String(msg.content || msg.reasoning_content || "").trim();
  return {
    ok: /pong/i.test(sample) || Boolean(sample),
    provider,
    kind: harness.kind,
    model: harness.model,
    baseUrl: harness.baseUrl,
    sample: sample.slice(0, 240),
  };
}

async function loadSystemPrompt(bot, settings, { hidden = false } = {}) {
  const [adapter, computer, capabilities, voice] = await Promise.all([
    ctx.readPrompt("local-adapter.txt"),
    ctx.readPrompt("computer-control.txt"),
    ctx.readPrompt("capabilities.txt"),
    ctx.readPrompt("voice.txt"),
  ]);
  const live = await ctx.liveContext({ bot, settings, hidden });
  return `${live}
${adapter}
${capabilities}
${computer}
${routines.promptBlock(bot)}
${voice}

## Sub8
After send_message, if the user asked for something on the desktop (research, Chrome, files they can see, clicks): call \`computer\` screenshot next, then click like a human.
web_search is available for facts. Prefer it over opening Google unless the user asked to use the browser.
Routines: ONE standing job, and only when the user asked to keep doing something on a clock (every N minutes, hourly, daily). "Check again", "try again", "resume", and one-shot desktop work are NOT routines — do the work now, do not upsert. "Run" / "resume" means execute, not rewrite. Never replace a long brief with the chat line. Never delete the only routine unless they said delete.
If a submit already landed or the UI is still loading, do not submit the same thing again. If a click fails twice, stop repeating it.
${await vault.promptBlock(bot.id)}
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

export async function runTurn({ bot, settings, userText, emit, hidden = false, images = [], signal, pullNudges, persistUser = true } = {}) {
  if (!Array.isArray(bot.routines)) bot.routines = [];
  if (!hidden && routines.looksLikeSchedule(userText)) {
    const parsed = routines.parseSchedule(userText);
    const { routine, merged, rejected } = routines.upsertRoutine(bot, {
      instruction: userText,
      intervalMs: parsed.intervalMs,
    });
    if (routine) await Promise.resolve(emit("routine", { routine, merged, rejected }));
  }

  const harness = resolveClient(settings, bot);
  if ((harness.provider === "ollama" || harness.provider === "lmstudio") && !harness.model) {
    const found = await detectLocalHarnesses();
    harness.model = found[harness.provider]?.models?.[0] || "";
    if (!harness.model) {
      const out = {
        id: `a${Date.now()}`,
        role: "assistant",
        content: `${harness.provider === "lmstudio" ? "LM Studio" : "Ollama"} is not running or has no model loaded.`,
        ts: Date.now(),
      };
      bot.messages.push(out);
      emit("message", out);
      return bot;
    }
  }
  const system = await loadSystemPrompt(bot, settings, { hidden });

  if (persistUser) {
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
  }

  const history = [
    { role: "system", content: system },
    ...bot.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .filter((m) => m.kind !== "activity" && m.kind !== "think")
      .filter((m) => !/^That failed: 400/.test(String(m.content || "")))
      .slice(-30)
      .map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        return { role: m.role === "user" || m.role === "assistant" ? m.role : "user", content: m.content };
      }),
  ];
  if (!persistUser && userText) {
    const last = history.at(-1);
    if (!(last?.role === "user" && last.content === userText)) {
      history.push({ role: "user", content: userText });
    }
  }
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

  let savedLogin = null;
  if (!hidden && !isHumanControl(bot.id)) {
    savedLogin = await maybeRunSavedLogin(bot, userText, emit, signal);
    if (savedLogin?.did) {
      history.push({
        role: "user",
        content: savedLogin.imageB64
          ? [
              { type: "text", text: savedLogin.brief },
              { type: "image_url", image_url: { url: `data:image/png;base64,${savedLogin.imageB64}` } },
            ]
          : savedLogin.brief,
      });
    }
  }

  if (harness.kind === "cli-host") {
    emit("tool", { name: "computer", args: { action: "screenshot" } });
    const work = {
      id: `tl${Date.now()}cli`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: `Working via ${harness.provider}`,
      ts: Date.now(),
    };
    bot.messages.push(work);
    emit("message", work);
    const text = await hostCli.runHostCli({
      provider: harness.provider,
      model: harness.model,
      userText: savedLogin?.did ? `${userText}\n\n${savedLogin.brief}` : userText,
      signal,
      bot,
      settings,
      hidden,
      emit,
      internalToken: settings.__internalToken,
      port: settings.__port,
    });
    const msg = { id: `a${Date.now()}`, role: "assistant", content: text, ts: Date.now() };
    bot.messages.push(msg);
    emit("message", msg);
    return bot;
  }

  if (harness.kind === "grok-build") {
    if (!bot.grokSessionId) bot.grokSessionId = bot.id;
    const desktop = looksLikeDesktopTask(userText);
    const grokText = savedLogin?.did
      ? `${userText}\n\n${savedLogin.brief}`
      : desktop
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
    const text = await runGrokBuild(harness, grokText, signal, bot, emit, { settings, hidden });
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
  let usedComputer = Boolean(savedLogin?.did);
  let usedVaultFill = Boolean(savedLogin?.did);
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
    const local = harness.provider === "ollama" || harness.provider === "lmstudio";
    const resp = local
      ? await completeLocal(harness, history, userText, signal)
      : await harness.client.chat.completions.create(
          { model: harness.model, messages: history, tools: TOOLS, tool_choice: "auto" },
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
      if (loginNeedle(userText) && !usedVaultFill && steps < maxSteps - 1) {
        history.push({ role: "assistant", content: lastVisible });
        history.push({
          role: "user",
          content:
            "Do not only say you will sign in. Call vault_list, click the username field, vault_fill field=username, press Return, then vault_fill field=password. Do not open the site again unless it is not on screen.",
        });
        continue;
      }
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
      if (name === "vault_fill") usedVaultFill = true;
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

/** Qwen 3.x jinja dies on long / consecutive-user histories ("No user query found"). */
function qwenSafeMessages(history, userText) {
  const sys = [];
  const compact = [];
  const toolNotes = [];
  let lastImage = null;
  for (const m of history || []) {
    if (!m?.role) continue;
    if (m.role === "system") {
      sys.push({ role: "system", content: String(m.content || "") });
      continue;
    }
    if (m.role === "tool") {
      const note = String(m.content || "").replace(/\s+/g, " ").trim();
      if (note) toolNotes.push(note.slice(0, 400));
      continue;
    }
    if (Array.isArray(m.content)) {
      const texts = m.content.filter((p) => p?.type === "text").map((p) => String(p.text || "")).join(" ");
      const img = m.content.find((p) => p?.type === "image_url");
      if (img) lastImage = img;
      if (texts.trim()) compact.push({ role: m.role, content: texts.slice(-4000) });
      continue;
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "user" && (content.startsWith("[routine]") || !content.trim())) continue;
    if (m.role === "assistant" && !content.trim() && !m.tool_calls) continue;
    if (compact.at(-1)?.role === m.role && !m.tool_calls) {
      compact.at(-1).content = content.slice(-4000);
      continue;
    }
    compact.push({ role: m.role, content: content.slice(-4000) });
  }
  while (compact.at(-1)?.role === "user") compact.pop();
  const lastNudge = [...(history || [])].reverse().find((m) => m.role === "user" && typeof m.content === "string" && m.content !== userText);
  const bits = [String(userText || "").trim() || "Continue."];
  if (toolNotes.length) bits.push(`Last tool results:\n${toolNotes.slice(-4).join("\n")}`);
  if (lastNudge?.content) bits.push(String(lastNudge.content).slice(-800));
  bits.push("Do the next real desktop step. Do not only say you will do it.");
  let tail = compact.slice(-4);
  while (tail[0]?.role === "assistant") tail.shift();
  const query = bits.join("\n\n");
  if (lastImage) {
    tail.push({
      role: "user",
      content: [{ type: "text", text: query }, lastImage],
    });
  } else {
    tail.push({ role: "user", content: query });
  }
  return [...sys, ...tail];
}

async function completeLocal(harness, history, userText, signal) {
  const query = String(userText || "").trim() || "Continue.";
  const attempts = [
    qwenSafeMessages(history, query),
    [...(history || []).filter((m) => m.role === "system"), { role: "user", content: query }],
  ];
  let lastErr;
  for (const messages of attempts) {
    try {
      return await harness.client.chat.completions.create(
        { model: harness.model, messages, tools: TOOLS, tool_choice: "auto" },
        signal ? { signal } : undefined,
      );
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/No user query found|jinja template/i.test(msg)) throw err;
    }
  }
  throw lastErr;
}

function toolSummary(name, args = {}, result = "") {
  if (name === "vault_list") return "Checked saved logins";
  if (name === "vault_fill") {
    return args.field === "username" ? "Pasted username" : "Pasted password";
  }
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
  return /\b(chrome|browser|click|desktop|computer|screenshot|flight|google|open |type |search|x\.com|twitter|post|tab|log\s*in|sign\s*in|gmail)\b/i.test(
    String(text || ""),
  );
}

export function loginNeedle(text) {
  const t = String(text || "").trim();
  if (!/\b(log\s*in|sign\s*in|signin|sign into)\b/i.test(t)) return "";
  const m = t.match(/\b(?:log\s*in|sign\s*in|signin|sign into)\s+(?:to\s+)?(.+)$/i);
  return (m ? m[1] : "").trim().toLowerCase().replace(/[.?!\s]+$/g, "");
}

export function scoreVaultAccount(acc, needle) {
  const blob = `${acc?.label || ""} ${acc?.site || ""} ${acc?.username || ""}`.toLowerCase();
  const n = String(needle || "").toLowerCase();
  if (!n || !blob.trim()) return 0;
  if (/\bgmail\b|google mail|mail\.google/.test(n) || n === "google") {
    return /gmail|mail\.google|google/.test(blob) ? 3 : 0;
  }
  const host = n.replace(/^https?:\/\//, "").split("/")[0];
  if (host && blob.includes(host)) return 2;
  if (blob.includes(n)) return 2;
  return 0;
}

function loginUrlFor(acc, needle) {
  const site = String(acc?.site || "").trim();
  if (/^https?:\/\//i.test(site)) return site;
  if (/gmail|mail\.google/i.test(`${site} ${needle}`)) return "https://mail.google.com";
  if (site) return site.includes(".") ? `https://${site.replace(/^\/+/, "")}` : "";
  if (/\bgmail\b/i.test(needle)) return "https://mail.google.com";
  return "";
}

function emitActivity(bot, emit, name, action, summary) {
  const activity = {
    id: `tl${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    role: "activity",
    kind: "tool",
    name,
    action,
    summary,
    ts: Date.now(),
  };
  bot.messages.push(activity);
  emit("message", activity);
}

async function maybeRunSavedLogin(bot, userText, emit, signal) {
  const needle = loginNeedle(userText);
  if (!needle || isHumanControl(bot.id)) return null;
  if (bot.vm?.status !== "running") return null;
  if (bot.vm?.setup && bot.vm.setup.ready === false) return null;
  const rows = await vault.grantedAccounts(bot.id);
  const ranked = rows.map((a) => ({ a, s: scoreVaultAccount(a, needle) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  const acc = ranked[0]?.a;
  if (!acc) return null;
  const url = loginUrlFor(acc, needle);
  if (!url) return null;
  const ack = {
    id: `a${Date.now()}`,
    role: "assistant",
    content: `Signing into ${acc.label} with the saved login.`,
    ts: Date.now(),
  };
  bot.messages.push(ack);
  emit("message", ack);
  emit("tool", { name: "computer", args: { action: "open", text: url } });
  await computerAction(bot, { action: "open", text: url }, emit);
  emitActivity(bot, emit, "computer", "open", `Opened ${url}`);
  if (signal?.aborted) return { did: true, brief: "Stopped before filling the login." };
  await vm.wait(1600);
  emit("tool", { name: "vault_fill", args: { account_id: acc.id, field: "username" } });
  const user = await vault.fillIntoDesktop(bot, acc.id, "username");
  emitActivity(bot, emit, "vault_fill", "vault_fill", toolSummary("vault_fill", { field: "username" }));
  await computerAction(bot, { action: "key", keys: "Return" }, emit);
  emitActivity(bot, emit, "computer", "key", "Pressed Return");
  await vm.wait(1800);
  if (signal?.aborted) return { did: true, brief: "Stopped after the username." };
  emit("tool", { name: "vault_fill", args: { account_id: acc.id, field: "password" } });
  const pass = await vault.fillIntoDesktop(bot, acc.id, "password");
  emitActivity(bot, emit, "vault_fill", "vault_fill", toolSummary("vault_fill", { field: "password" }));
  await computerAction(bot, { action: "key", keys: "Return" }, emit);
  emitActivity(bot, emit, "computer", "key", "Pressed Return");
  await vm.wait(1600);
  const shot = await computerAction(bot, { action: "screenshot" }, emit);
  emitActivity(bot, emit, "computer", "screenshot", "Looked at the screen");
  const brief =
    `Sub8 opened ${url} and pasted the saved ${acc.label} username${user.ok ? "" : " (username paste failed)"} ` +
    `then password${pass.ok ? "" : " (password paste failed)"}. Look at the screenshot. ` +
    `If this is the inbox or the signed-in home, tell the user you're in. ` +
    `If you see 2FA, a Choose-an-account picker, or a wrong field, click that. Do not open Gmail again from scratch.`;
  return { did: true, brief, imageB64: shot.imageB64 || null };
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
    const hostTools = new Set([
      "send_message",
      "upsert_routine",
      "list_routines",
      "disable_routine",
      "web_search",
      "vault_list",
    ]);
    if (bot.vm?.status !== "running" && !hostTools.has(name)) {
      return { text: "Computer is not running yet." };
    }
    if (name === "vault_list") {
      const rows = await vault.grantedAccounts(bot.id);
      return { text: rows.length ? JSON.stringify(rows, null, 2) : "No saved logins granted to this Bot." };
    }
    if (name === "vault_fill") {
      const filled = await vault.fillIntoDesktop(bot, args.account_id, args.field || "password");
      return { text: filled.text };
    }
    if (name === "send_message") {
      const secrets = await vault.listSecrets();
      const out = {
        id: `a${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        role: "assistant",
        content: vault.redactSecrets(String(args.content || ""), secrets),
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
      const secrets = await vault.listSecrets();
      const cmd = String(args.command || "");
      if (secrets.some((s) => s && cmd.includes(s))) {
        return { text: "Blocked: do not put vault secrets in the shell. Use vault_fill or octo-vault fill." };
      }
      const r = await vm.shell(bot, cmd);
      return { text: vault.redactSecrets(r.output || (r.ok ? "(ok)" : "(failed)"), secrets) };
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
  if (action === "clipboard_read") {
    const raw = (await vm.clipboardRead(bot)) || "";
    const secrets = await vault.listSecrets();
    if (secrets.some((s) => s && raw.includes(s))) return { text: "(redacted)" };
    return { text: raw || "(empty)" };
  }
  if (action === "clipboard_write") {
    const secrets = await vault.listSecrets();
    if (secrets.some((s) => s && String(args.text || "").includes(s))) {
      return { text: "Blocked: do not write vault secrets. Use vault_fill." };
    }
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
  else if (action === "type") {
    const secrets = await vault.listSecrets();
    if (secrets.some((s) => s && String(args.text || "").includes(s))) {
      return { text: "Blocked: do not type vault secrets. Click the field, then vault_fill." };
    }
    await vm.typeText(bot, args.text || "");
  }
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

function summarizeVmCommand(cmd = "") {
  const c = String(cmd);
  if (/octo-click|xdotool click/i.test(c)) {
    if (/\bclick\s+(4|5|6|7)\b/.test(c) || /\bscroll\b/i.test(c)) {
      return { name: "computer", action: "scroll", summary: "Scrolled" };
    }
    if (/--repeat\s*2|double_click/i.test(c)) {
      return { name: "computer", action: "double_click", summary: "Double-clicked" };
    }
    if (/\bclick\s+3\b/.test(c)) {
      return { name: "computer", action: "right_click", summary: "Right-clicked" };
    }
    return { name: "computer", action: "left_click", summary: "Clicked" };
  }
  if (/xdotool type\b/i.test(c)) {
    const t = (c.match(/type(?:\s+--\S+)*\s+'([^']*)'|type(?:\s+--\S+)*\s+"([^"]*)"/) || []).filter(Boolean)[1] || "";
    return { name: "computer", action: "type", summary: toolSummary("computer", { action: "type", text: t }) };
  }
  if (/xdotool key\b/i.test(c)) {
    const keys = (c.match(/key(?:\s+--\S+)*\s+(\S+)/) || [])[1] || "";
    return { name: "computer", action: "key", summary: toolSummary("computer", { action: "key", keys }) };
  }
  if (/xdotool mousemove/i.test(c)) {
    return { name: "computer", action: "mouse_move", summary: "Moved the pointer" };
  }
  if (/chrome-desktop|google-chrome/i.test(c)) {
    const url = (c.match(/https?:\/\/\S+/) || [])[0] || "";
    return { name: "computer", action: "open", summary: toolSummary("computer", { action: "open", text: url }) };
  }
  if (/\b(scrot|screenshot)\b/i.test(c)) {
    return { name: "computer", action: "screenshot", summary: "Looked at the screen" };
  }
  if (/octo-vault\s+fill/i.test(c)) {
    const field = /\busername\b/i.test(c) ? "username" : "password";
    return { name: "vault_fill", action: "vault_fill", summary: toolSummary("vault_fill", { field }) };
  }
  if (/octo-vault\s+list/i.test(c)) {
    return { name: "vault_list", action: "vault_list", summary: "Checked saved logins" };
  }
  return { name: "shell", action: "shell", summary: toolSummary("shell", { command: c }) };
}

function emitGrokToolActivity(bot, emit, seen, evt) {
  const id = evt.toolCallId;
  if (!id || seen.has(id) || typeof emit !== "function") return;
  seen.add(id);
  const cmd = evt.rawInput?.command || evt.rawOutput?.command || "";
  const mapped =
    evt.toolName === "web_search"
      ? {
          name: "web_search",
          action: "web_search",
          summary: toolSummary("web_search", { query: evt.rawInput?.query || evt.rawInput?.q || "" }),
        }
      : summarizeVmCommand(cmd);
  const activity = {
    id: `tl${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    role: "activity",
    kind: "tool",
    name: mapped.name,
    action: mapped.action,
    summary: mapped.summary,
    ts: Date.now(),
  };
  bot.messages.push(activity);
  emit("tool", { name: mapped.name, args: { action: mapped.action, command: cmd } });
  emit("message", activity);
}

function runGrokBuild(harness, userText, signal, bot, emit, { settings, hidden = false } = {}) {
  const box = bot?.vm?.container || (bot?.id ? vm.containerName(bot.id) : "");
  if (!box) {
    return Promise.resolve(
      "Grok Build only runs inside a bot computer. Start the computer first.",
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
    const signed = await vm.grokSignedIn(box);
    if (!signed.ok) {
      return "Grok Build is not signed in on this computer. Open Settings → Harness → Grok Build and sign in on this Mac. That session is copied into the Bot computer.";
    }
    const extra = await ctx.agentsExtra({ bot, settings, hidden });
    await vm.installAgentsMd(box, extra);
    const caps = await ctx.readPrompt("capabilities.txt");
    const rules = `${await fs.readFile(path.join(appRoot, "prompts", "grok-build-vm.txt"), "utf8")}\n${caps}\n${extra}\n`;
    const exists = await grokSessionOnDisk(box, sessionId);
    const recap = recapForGrok(bot);
    const prompt = exists
      ? userText
      : recap
        ? `Continuing this Bot's conversation on my computer.\nPrior conversation:\n${recap}\n\nUser:\n${userText}`
        : userText;
    const promptFile = "/tmp/sub8-grok-prompt.txt";
    await vm.writeFileToContainer(box, promptFile, prompt);
    const grokArgs = ["-m", harness.model || "grok-4.6"];
    if (exists) grokArgs.push("--resume", sessionId);
    else grokArgs.push("--session-id", sessionId);
    // Same grok-build drive path on every OS. dontAsk + no TTY cancels
    // tools (Windows Docker always; Electron on Mac often too).
    grokArgs.push(
      "--prompt-file",
      promptFile,
      "--permission-mode",
      "bypassPermissions",
      "--always-approve",
      "--max-turns",
      "32",
      "--no-alt-screen",
      "--output-format",
      "streaming-json",
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
      const child = vm.dockerSpawn(args);
      let buf = "";
      let reply = "";
      let tail = "";
      const seenTools = new Set();
      let done = false;
      const IDLE_MS = 180_000;
      const HARD_MS = 20 * 60_000;
      let idleTimer = null;
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            finish(
              reply.trim() ||
                `Grok Build went silent for 3 minutes inside the computer.${tail ? ` Last line: ${tail}` : ""} Try again or Stop.`,
            ),
          IDLE_MS,
        );
      };
      const finish = (text) => {
        if (done) return;
        done = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        try {
          if (!child.killed) child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(text);
      };
      const takeLine = (line) => {
        const raw = String(line || "").trim();
        if (!raw) return;
        if (raw[0] !== "{") {
          tail = raw.slice(-400);
          return;
        }
        let evt;
        try {
          evt = JSON.parse(raw);
        } catch {
          tail = raw.slice(-400);
          return;
        }
        const text =
          (evt.type === "text" && typeof evt.data === "string" && evt.data) ||
          (typeof evt.text === "string" && evt.text) ||
          (typeof evt.result === "string" && evt.result) ||
          "";
        if (text) reply += text;
        if (evt.type === "tool_call" || evt.type === "tool" || evt.tool) emitGrokToolActivity(bot, emit, seenTools, evt);
      };
      const onChunk = (chunk) => {
        bumpIdle();
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || "";
        for (const line of lines) takeLine(line);
      };
      bumpIdle();
      const hardTimer = setTimeout(
        () => finish(reply.trim() || "Grok Build hit the 20-minute limit inside the computer."),
        HARD_MS,
      );
      signal?.addEventListener("abort", () => finish("Stopped."));
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (e) => finish(`Grok Build harness failed: ${e.message}`));
      child.on("close", () => {
        takeLine(buf);
        vault
          .listSecrets()
          .then((secrets) => finish(vault.redactSecrets(reply.trim() || "(no output from grok)", secrets)))
          .catch(() => finish(reply.trim() || "(no output from grok)"));
      });
    });
  })();
}
