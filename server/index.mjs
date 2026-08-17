import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as store from "./store.mjs";
import * as vm from "./vm.mjs";
import * as routines from "./routines.mjs";
import { runTurn, publicBot, pingHarness, webSearch, orchestratorReply, isChatQuestion } from "./agent.mjs";
import { setHumanControl, isHumanControl } from "./control.mjs";
import { appRoot, dataDir } from "./paths.mjs";
import * as appUpdate from "./update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = appRoot;
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use("/screens", express.static(path.join(dataDir, "screens")));
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three")));

const busyIds = new Set();
function toClient(bot) {
  return {
    ...publicBot(bot),
    busy: busyIds.has(bot.id),
    storage: {
      sessionId: bot.id,
      botsFile: store.botsPath,
      conversationFile: store.conversationPath(bot.id),
      screensFile: store.screenPath(bot.id),
      dataDir: store.dataDir,
    },
  };
}
app.use(
  express.static(path.join(root, "web"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
  const iv = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clearInterval(iv);
    }
  }, 15_000);
  req.on("close", () => {
    clearInterval(iv);
    clients.delete(res);
  });
});

function whisperModel() {
  const home = process.env.HOME || "";
  const names = [
    path.join(root, "scripts", ".cache", "ggml-base.en.bin"),
    path.join(root, "scripts", ".cache", "ggml-tiny.en.bin"),
    path.join(home, "vid2", "models", "ggml-base.en.bin"),
    path.join(home, "Library", "Application Support", "com.danielfarina.grok-remote", "whisper-models", "ggml-base.bin"),
    "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin",
  ];
  return names.find((p) => existsSync(p));
}

app.post("/api/dictate", (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const buf = Buffer.concat(chunks);
    if (buf.length < 800) return res.status(400).json({ ok: false, error: "empty audio" });
    const raw = path.join("/tmp", `octo-dictate-${Date.now()}`);
    const src = `${raw}.bin`;
    const wav = `${raw}.wav`;
    try {
      await fs.writeFile(src, buf);
      const ff = spawnSync(
        "ffmpeg",
        ["-y", "-i", src, "-ac", "1", "-ar", "16000", wav],
        { encoding: "utf8", timeout: 20_000 },
      );
      const use = existsSync(wav) ? wav : src;
      if (!existsSync(use) || ff.status !== 0 && !existsSync(wav)) {
        return res.status(422).json({ ok: false, error: ff.stderr?.slice(-200) || "couldn’t decode audio" });
      }
      const model = whisperModel();
      const cli = "/opt/homebrew/bin/whisper-cli";
      if (!model) {
        return res.status(500).json({ ok: false, error: "No Whisper model on this Mac." });
      }
      const r = spawnSync(cli, ["-m", model, "-f", use, "-nt", "-np", "-l", "en"], {
        encoding: "utf8",
        timeout: 45_000,
      });
      const text = String(r.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("[") && !l.startsWith("whisper_"))
        .join(" ")
        .trim();
      if (text) return res.json({ ok: true, text });
      const err = String(r.stderr || "").split("\n").slice(-3).join(" ") || "no speech";
      res.status(422).json({ ok: false, error: err, code: r.status });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    } finally {
      fs.unlink(src).catch(() => {});
      fs.unlink(wav).catch(() => {});
    }
  });
});

app.get("/api/health", async (_req, res) => {
  const docker = await vm.dockerStatus();
  res.json({ ok: true, docker });
});

app.get("/api/ready", async (_req, res) => {
  try {
    const settings = await store.loadSettings();
    const h = settings.harness || {};
    const harnessOk =
      ((h.provider || "grok-build") === "grok-build" || h.provider === "spacexai" || h.provider === "custom") &&
      (h.model || "grok-4.6") === "grok-4.6";
    const bots = await store.loadBots();
    const bot = bots[0] || null;
    const stream = bot ? await vm.streamHealth(bot) : { ok: false, error: "no bot" };
    const ready = Boolean(harnessOk && process.env.XAI_API_KEY && (!bot || stream.ok));
    res.json({
      ok: ready,
      health: true,
      harness: { provider: h.provider, model: h.model, baseUrl: h.baseUrl, ok: harnessOk },
      hasEnvKey: Boolean(process.env.XAI_API_KEY),
      bot: bot ? { id: bot.id, name: bot.name, vm: bot.vm } : null,
      stream,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/settings", async (_req, res) => {
  const s = await store.loadSettings();
  const safe = { ...s, harness: { ...s.harness, apiKey: s.harness.apiKey ? "••••" : "" } };
  res.json({
    settings: safe,
    hasEnvKey: Boolean(process.env.XAI_API_KEY),
    hasGrokAuth: await vm.hostHasGrokAuth(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    docker: await vm.dockerStatus(),
    appVersion: appUpdate.appVersion(),
  });
});

app.get("/api/update", async (_req, res) => {
  res.json(await appUpdate.checkForAppUpdate());
});

app.put("/api/settings", async (req, res) => {
  const prev = await store.loadSettings();
  const next = { ...prev, ...req.body };
  if (req.body.harness) {
    next.harness = { ...prev.harness, ...req.body.harness };
    if (req.body.harness.apiKey === "••••") next.harness.apiKey = prev.harness.apiKey;
  }
  res.json(await store.saveSettings(next));
});

app.post("/api/harness/grok-login", async (req, res) => {
  if (!(await vm.hostHasGrokAuth())) {
    vm.startHostGrokOAuth();
    return res.json({
      ok: true,
      needHostLogin: true,
      message: "Finish Grok OAuth in your Mac browser. That session will be copied into every computer.",
    });
  }
  const pushed = await vm.pushHostGrokAuthAll();
  const signed = pushed.filter((p) => p.ok).length;
  res.json({
    ok: signed > 0 || pushed.length === 0,
    reused: true,
    computers: pushed.length,
    signedIn: signed,
    message:
      signed > 0
        ? `Reused this Mac’s Grok session on ${signed} computer${signed === 1 ? "" : "s"}.`
        : "Copied the session but Grok inside a computer still needs a moment. Try Test connection.",
  });
});

app.get("/api/harness/grok-login", async (req, res) => {
  const botId = String(req.query.botId || "");
  const bot = botId ? await store.getBot(botId) : (await store.loadBots())[0];
  const box = bot?.vm?.container;
  if (!box) return res.json({ ok: false, started: false, signedIn: false });
  const job = vm.grokOAuthStatus(box);
  const signed = await vm.grokSignedIn(box);
  res.json({ ok: true, ...job, signedIn: signed.ok, container: box });
});

app.post("/api/harness/test", async (_req, res) => {
  try {
    const settings = await store.loadSettings();
    res.json(await pingHarness(settings));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "empty query" });
    const settings = await store.loadSettings();
    const text = await webSearch(settings, query);
    res.json({ ok: !text.startsWith("web_search failed"), query, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/bots", async (_req, res) => {
  res.json((await store.loadBots()).map(toClient));
});

app.get("/api/bots/:id/trace", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const { read } = await import("./trace.mjs");
  res.json({ botId: bot.id, events: await read(bot.id, Number(req.query.limit) || 80) });
});

app.get("/api/bots/:id", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  res.json(toClient(bot));
});

app.post("/api/bots", async (req, res) => {
  const bot = store.newBot(req.body || {});
  await store.upsertBot(bot);
  broadcast("bots", (await store.loadBots()).map(toClient));
  res.json(toClient(bot));
  provision(bot.id).catch((err) => console.error("provision", err));
});

app.post("/api/bots/:id/duplicate", async (req, res) => {
  const src = await store.getBot(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  const copy = store.newBot({
    name: `${src.name} copy`,
    title: src.title,
    description: src.description,
    instructions: src.instructions,
    color: src.color,
    avatar: src.avatar,
    section: src.section,
  });
  await store.upsertBot(copy);
  broadcast("bots", (await store.loadBots()).map(toClient));
  res.json(toClient(copy));
  provision(copy.id).catch((err) => console.error("provision", err));
});

app.patch("/api/bots/:id", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const body = { ...req.body };
  if (body.avatar && typeof body.avatar === "object") {
    bot.avatar = {
      expression: body.avatar.expression || bot.avatar?.expression || "neutral",
      animation: body.avatar.animation || bot.avatar?.animation || "idle",
    };
    delete body.avatar;
  }
  Object.assign(bot, body, { id: bot.id, vm: bot.vm, messages: bot.messages, routines: bot.routines });
  await store.upsertBot(bot);
  broadcast("bot", toClient(bot));
  res.json(toClient(bot));
});

const deletedIds = new Set();

app.delete("/api/bots/:id", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  deletedIds.add(bot.id);
  try {
    await vm.stopVm(bot);
  } catch {
    /* already gone */
  }
  const next = await store.deleteBot(bot.id);
  if (!next) return res.status(404).json({ error: "not found" });
  const keep = next.map((b) => b.vm?.container || vm.containerName(b.id));
  vm.sweepOrphans(keep).catch((err) => console.error("sweep", err));
  broadcast("bots", next.map(toClient));
  res.json({ ok: true });
});

app.get("/api/bots/:id/stream-health", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  try {
    const health = await vm.streamHealth(bot);
    const shotPath = path.join(dataDir, "screens", `${bot.id}.png`);
    let shot = null;
    try {
      const buf = await fs.readFile(shotPath);
      const w = buf.length >= 24 ? buf.readUInt32BE(16) : 0;
      const h = buf.length >= 24 ? buf.readUInt32BE(20) : 0;
      shot = { bytes: buf.length, width: w, height: h, sizeOk: w === 1024 && h === 768 };
    } catch {
      shot = null;
    }
    res.json({ ...health, shot, vm: bot.vm, docker: await vm.dockerStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/bots/:id/screen", async (req, res) => {
  const file = path.join(dataDir, "screens", `${req.params.id}.png`);
  try {
    res.type("png").send(await fs.readFile(file));
  } catch {
    res.status(404).end();
  }
});

app.post("/api/bots/:id/vm", async (req, res) => {
  const action = req.body?.action || "start";
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  try {
    if (action === "reset") await vm.stopVm(bot);
    const info = await vm.startVm(
      bot,
      (m) => broadcast("log", { botId: bot.id, m }),
      async () => deletedIds.has(bot.id) || !(await store.getBot(bot.id)),
    );
    bot.vm = { ...bot.vm, ...info, error: null };
    await store.upsertBot(bot);
    broadcast("bot", toClient(bot));
    res.json(toClient(bot));
  } catch (err) {
    bot.vm = { ...bot.vm, status: "error", error: err.message };
    await store.upsertBot(bot);
    broadcast("bot", toClient(bot));
    res.status(500).json({ error: err.message });
  }
});

const turnLocks = new Map();
const turnEpoch = new Map();
const turnAbort = new Map();
const inflightTurns = new Map();

function epochOf(id) {
  return turnEpoch.get(id) || 0;
}

function enqueueTurn(botId, fn) {
  const epoch = epochOf(botId);
  const prev = turnLocks.get(botId) || Promise.resolve();
  const next = prev.then(() => {
    if (epochOf(botId) !== epoch) return;
    return fn();
  }, () => {
    if (epochOf(botId) !== epoch) return;
    return fn();
  });
  turnLocks.set(botId, next.catch(() => {}));
  return next;
}

function stopTurn(botId) {
  turnEpoch.set(botId, epochOf(botId) + 1);
  const ac = turnAbort.get(botId);
  if (ac) {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }
  busyIds.delete(botId);
}

app.post("/api/bots/:id/control", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const on = Boolean(req.body?.on);
  setHumanControl(bot.id, on);
  if (on) stopTurn(bot.id);
  const note = {
    id: `ctl${Date.now()}`,
    role: "assistant",
    content: on
      ? "You've got the computer. I'll wait until you release it."
      : "You're done driving. I can use the computer again.",
    ts: Date.now(),
  };
  await store.patchBot(bot.id, (live) => {
    live.messages = live.messages || [];
    live.messages.push(note);
  });
  broadcast("message", { botId: bot.id, ...note });
  broadcast("control", { botId: bot.id, on });
  res.json({ ok: true, on });
});

app.post("/api/bots/:id/stop", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const wasBusy = busyIds.has(bot.id);
  stopTurn(bot.id);
  if (wasBusy) {
    await store.patchBot(bot.id, (live) => {
      live.messages = live.messages || [];
      live.messages.push({
        id: `stop${Date.now()}`,
        role: "assistant",
        content: "Stopped.",
        ts: Date.now(),
      });
    });
  }
  const live = await store.getBot(bot.id);
  broadcast("bot", toClient(live));
  res.json({ ok: true, stopped: wasBusy });
});

app.post("/api/bots/:id/messages", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const text = String(req.body?.content || "").trim();
  const images = Array.isArray(req.body?.images) ? req.body.images.filter((x) => typeof x === "string").slice(0, 16) : [];
  if (!text && !images.length) return res.status(400).json({ error: "empty" });
  const live = inflightTurns.get(bot.id);
  if (busyIds.has(bot.id) && live) {
    const userMsg = {
      id: `u${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      role: "user",
      content: text || "See attached.",
      ts: Date.now(),
    };
    await store.patchBot(bot.id, (b) => {
      b.messages = b.messages || [];
      b.messages.push(userMsg);
    });
    broadcast("message", { botId: bot.id, ...userMsg });
    const question = isChatQuestion(userMsg.content);
    if (!question) live.nudges.push(userMsg.content);
    res.json({ ok: true, nudged: !question });
    talkWhileWorking(bot.id, userMsg.content).catch((err) => console.error("orchestrator", err));
    return;
  }
  res.json({ ok: true });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, text || "See attached.", false, images));
});

app.post("/api/bots/:id/teach", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const name = String(req.body?.name || "Taught task").trim();
  const frames = Array.isArray(req.body?.frames) ? req.body.frames.filter((x) => typeof x === "string").slice(0, 16) : [];
  const text = `I just demonstrated a task called "${name}". The screenshots are in order. Learn the steps, then upsert_routine so you can run this task again on your own. Name the routine clearly.`;
  res.json({ ok: true, name, frames: frames.length });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, text, false, frames));
});

app.get("/api/bots/:id/routines", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  res.json(bot.routines || []);
});

app.post("/api/bots/:id/routines", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const body = req.body || {};
  const minutes = Number(body.interval_minutes ?? body.intervalMinutes);
  const { routine, merged } = routines.upsertRoutine(bot, {
    name: body.name,
    instruction: body.instruction,
    groupKey: body.group_key || body.groupKey,
    intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : body.intervalMs,
  });
  await store.upsertBot(bot);
  broadcast("bot", toClient(bot));
  res.json({ routine, merged });
});

app.patch("/api/bots/:id/routines/:rid", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  if (!Array.isArray(bot.routines)) bot.routines = [];
  const r = bot.routines.find((x) => x.id === req.params.rid);
  if (!r) return res.status(404).json({ error: "routine not found" });
  const body = req.body || {};
  if (typeof body.name === "string") r.name = body.name.trim() || r.name;
  if (typeof body.instruction === "string") r.instruction = body.instruction;
  if (typeof body.group_key === "string" || typeof body.groupKey === "string") {
    r.groupKey = body.group_key || body.groupKey;
  }
  const minutes = Number(body.interval_minutes ?? body.intervalMinutes);
  if (Number.isFinite(minutes) && minutes > 0) r.intervalMs = minutes * 60_000;
  if (typeof body.enabled === "boolean") r.enabled = body.enabled;
  r.updatedAt = Date.now();
  await store.upsertBot(bot);
  broadcast("bot", toClient(bot));
  res.json(r);
});

app.delete("/api/bots/:id/routines/:rid", async (req, res) => {
  let missing = false;
  const live = await store.patchBot(req.params.id, (bot) => {
    const next = (bot.routines || []).filter((x) => x.id !== req.params.rid);
    if (next.length === (bot.routines || []).length) missing = true;
    else bot.routines = next;
  });
  if (!live) return res.status(404).json({ error: "not found" });
  if (missing) return res.status(404).json({ error: "routine not found" });
  broadcast("bot", toClient(live));
  res.json({ ok: true });
});

async function talkWhileWorking(botId, text) {
  const bot = await store.getBot(botId);
  const settings = await store.loadSettings();
  if (!bot) return;
  const content = await orchestratorReply({ bot, settings, userText: text });
  if (!content) return;
  const out = {
    id: `o${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    role: "assistant",
    content,
    ts: Date.now(),
  };
  await store.patchBot(botId, (b) => {
    b.messages = b.messages || [];
    b.messages.push(out);
  });
  broadcast("message", { botId, ...out });
}

async function runUserTurn(botId, text, hidden, images = []) {
  const ac = new AbortController();
  turnAbort.set(botId, ac);
  busyIds.add(botId);
  const bag = { nudges: [] };
  inflightTurns.set(botId, bag);
  try {
    let bot = await store.getBot(botId);
    if (!bot) return;
    broadcast("bot", toClient(bot));
    const ready = await vm.waitForDesktop(bot, {
      timeoutMs: 90_000,
      onLog: (m) => broadcast("log", { botId, m }),
      shouldAbort: async () => ac.signal.aborted || deletedIds.has(botId),
    });
    if (ac.signal.aborted) return;
    bot = await store.getBot(botId);
    if (bot && ready.health) {
      bot.vm = { ...bot.vm, ...(ready.ok ? { status: "running", error: null } : { error: ready.reason }) };
      await store.upsertBot(bot);
      broadcast("bot", toClient(bot));
    }
    if (!ready.ok) {
      const live = await store.getBot(botId);
      if (live) {
        live.messages = live.messages || [];
        live.messages.push({
          id: `a${Date.now()}`,
          role: "assistant",
          content: ready.reason || "Computer is not ready yet.",
          ts: Date.now(),
        });
        await store.upsertBot(live);
        broadcast("bot", toClient(live));
      }
      return;
    }
    bot = await store.getBot(botId);
    const settings = await store.loadSettings();
    await runTurn({
      bot,
      settings,
      userText: text,
      hidden,
      images,
      signal: ac.signal,
      pullNudges: () => bag.nudges.splice(0),
      emit: (event, data) => {
        broadcast(event, { botId, ...data });
        if (event === "routine" || event === "message") return store.upsertBot(bot);
      },
    });
    // Don't let a long turn resurrect routines/vm state deleted while it ran.
    const latest = await store.getBot(botId);
    if (latest) {
      bot.routines = latest.routines || [];
      bot.vm = latest.vm;
    } else if (!Array.isArray(bot.routines)) {
      bot.routines = [];
    }
    await store.upsertBot(bot);
    broadcast("bot", toClient(bot));
  } catch (err) {
    const aborted = ac.signal.aborted || /abort|stopped/i.test(err.message || "");
    if (!aborted) {
      broadcast("error", { botId, error: err.message });
      const b = await store.getBot(botId);
      if (b) {
        b.messages.push({
          id: `e${Date.now()}`,
          role: "assistant",
          content: `That failed: ${err.message}`,
          ts: Date.now(),
        });
        await store.upsertBot(b);
        broadcast("bot", toClient(b));
      }
    }
  } finally {
    if (turnAbort.get(botId) === ac) turnAbort.delete(botId);
    inflightTurns.delete(botId);
    busyIds.delete(botId);
    const live = await store.getBot(botId);
    if (live) broadcast("bot", toClient(live));
  }
}

async function tickRoutines() {
  const bots = await store.loadBots();
  const now = Date.now();
  for (const bot of bots) {
    if (isHumanControl(bot.id)) continue;
    const due = routines.dueRoutines(bot, now);
    if (!due.length) continue;
    const packs = routines.packDue(due);
    for (const pack of packs) {
      await store.patchBot(bot.id, (live) => {
        for (const id of pack.ids) {
          const r = (live.routines || []).find((x) => x.id === id);
          if (r) {
            r.lastRunAt = now;
            r.runs = [...(Array.isArray(r.runs) ? r.runs : []), { ts: now }].slice(-24);
          }
        }
      });
      const prompt = `Standing routine "${pack.name}" is due. Do this work now, then stop if nothing changed:\n${pack.instruction}`;
      enqueueTurn(bot.id, () => runUserTurn(bot.id, prompt, true));
    }
  }
}

setInterval(() => tickRoutines().catch((e) => console.error("routines", e)), 15_000);

async function provision(id) {
  if (deletedIds.has(id)) return;
  const bot = await store.patchBot(id, (live) => {
    live.vm = { ...live.vm, status: "starting", error: null };
  });
  if (!bot) return;
  broadcast("bot", toClient(bot));
  try {
    const info = await vm.startVm(
      bot,
      (m) => broadcast("log", { botId: id, m }),
      async () => deletedIds.has(id) || !(await store.getBot(id)),
    );
    const live = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, ...info, error: null };
    });
    if (live) broadcast("bot", toClient(live));
  } catch (err) {
    const live = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, status: "error", error: err.message };
    });
    if (live) broadcast("bot", toClient(live));
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(root, "web", "index.html"));
});

async function ensureDesktops() {
  const dock = await vm.dockerStatus();
  if (!dock.ok) return dock;
  const bots = await store.loadBots();
  for (const bot of bots) {
    if (deletedIds.has(bot.id) || isHumanControl(bot.id)) continue;
    const starting = bot.vm?.status === "starting";
    const stuckStart = starting && !bot.vm?.container;
    if (bot.vm?.status === "running" || (starting && !stuckStart)) continue;
    provision(bot.id).catch((err) => console.error("ensure desktop", bot.id, err));
  }
  return dock;
}

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`Sub8 http://127.0.0.1:${PORT}`);
  try {
    const bots = await store.loadBots();
    const keep = bots.map((b) => b.vm?.container || vm.containerName(b.id));
    const gone = await vm.sweepOrphans(keep);
    if (gone.length) console.log("swept orphan computers", gone.join(", "));
  } catch (err) {
    console.error("startup sweep", err);
  }
  ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  setInterval(() => {
    ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  }, 12_000);
});
