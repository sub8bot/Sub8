import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as store from "./store.mjs";
import * as vm from "./vm.mjs";
import * as routines from "./routines.mjs";
import { runTurn, publicBot, pingHarness, webSearch, orchestratorReply, isChatQuestion, HARNESS_PROVIDERS, harnessFor, setTeamDispatch, setTeamReply, setStopBot } from "./agent.mjs";
import { detectLocalHarnesses } from "./local-llm.mjs";
import { collectHarnessStatus } from "./harness-status.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { setHumanControl, isHumanControl } from "./control.mjs";
import { appRoot, dataDir } from "./paths.mjs";
import * as appUpdate from "./update.mjs";
import * as vault from "./vault.mjs";
import * as computers from "./computers.mjs";
import * as hostCli from "./host-cli.mjs";
import { resolveZone } from "./context.mjs";
import * as teams from "./teams.mjs";
import * as memory from "./memory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = appRoot;
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use("/screens", express.static(path.join(dataDir, "screens")));
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three")));

const busyIds = new Set();
const internalToken = randomBytes(24).toString("hex");
function toClient(bot, opts = {}) {
  const mapped = bot.vm?.container ? vm.cachedMappedPort(bot.vm.container) : null;
  const novncPort = vm.resolveStreamPort(bot.vm?.novncPort, mapped);
  const client = publicBot(bot, { tail: opts.tail ?? 24, ...opts });
  if (client.vm && novncPort && client.vm.novncPort !== novncPort) {
    client.vm = { ...client.vm, novncPort };
  }
  return {
    ...client,
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

app.post("/api/docker/recover", async (req, res) => {
  req.setTimeout(180_000);
  res.setTimeout(180_000);
  try {
    const r = await vm.recoverDocker();
    if (r.ok) {
      const rows = await computers.listComputers();
      const list = await vm.listLocalbotStates({ force: true });
      for (const row of rows) {
        const st = list.states.get(row.container);
        if (st && (st.status === "exited" || st.status === "created") && row.status !== "exited" && row.status !== "stopped") {
          await vm.startExistingContainer(row.container);
        }
      }
    }
    const docker = r.docker || (await vm.dockerStatus());
    const computersLive = docker.ok ? await liveComputers() : await computers.listComputers();
    broadcast("computers", { dirty: true });
    res.json({ ok: r.ok, action: r.action, killed: r.killed, log: r.log || "", docker, computers: computersLive });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
    timezone: resolveZone(s),
    docker: await vm.dockerStatus(),
    appVersion: appUpdate.appVersion(),
    harnessProviders: HARNESS_PROVIDERS,
  });
});

app.post("/api/internal/emit", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const botId = req.body?.botId;
  const event = req.body?.event || "message";
  const data = req.body?.data || {};
  if (!botId) return res.status(400).json({ error: "botId required" });
  if (event === "message" && data?.role) {
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      if (data.id && b.messages.some((m) => m.id === data.id)) return;
      b.messages.push(data);
    });
  }
  broadcast(event, { botId, ...data });
  import("./hermes-acp.mjs")
    .then((h) => h.touchHermesAcp())
    .catch(() => {});
  res.json({ ok: true });
});

app.post("/api/internal/team-dispatch", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  if (req.body?.stopId) {
    stopTurn(String(req.body.stopId));
    deletedIds.add(String(req.body.stopId));
    return res.json({ ok: true, stopped: true });
  }
  const toId = String(req.body?.toId || "");
  const fromId = String(req.body?.fromId || "");
  const content = String(req.body?.content || "").trim();
  if (!toId || !content) return res.status(400).json({ error: "toId and content required" });
  const from = fromId ? await store.getBot(fromId) : null;
  dispatchToTeammate(toId, content, from);
  res.json({ ok: true });
});

app.get("/api/update", async (req, res) => {
  const current = String(req.query.current || "").trim() || undefined;
  res.json(await appUpdate.checkForAppUpdate({ current }));
});

app.get("/api/vault", async (_req, res) => {
  try {
    res.json(await vault.snapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vault/groups", async (req, res) => {
  const group = await vault.upsertGroup({ id: req.body?.id, name: req.body?.name });
  res.json(group);
});

app.delete("/api/vault/groups/:id", async (req, res) => {
  res.json(await vault.deleteGroup(req.params.id));
});

app.post("/api/vault/accounts", async (req, res) => {
  const acc = await vault.upsertAccount(req.body || {});
  res.json(acc);
});

app.patch("/api/vault/accounts/:id", async (req, res) => {
  const acc = await vault.upsertAccount({ ...(req.body || {}), id: req.params.id });
  res.json(acc);
});

app.delete("/api/vault/accounts/:id", async (req, res) => {
  res.json(await vault.deleteAccount(req.params.id));
});

app.get("/api/vault/accounts/:id/reveal", async (req, res) => {
  const acc = await vault.revealAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  res.json(acc);
});

app.get("/api/computers/:id/preview", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).end();
  const primary = vm.computerPreviewPath(row.id);
  const fallbacks = [
    primary,
    row.lastBotId ? path.join(dataDir, "screens", `${row.lastBotId}.png`) : "",
    row.lastBotId ? store.screenPath(row.lastBotId) : "",
  ].filter(Boolean);
  for (const file of fallbacks) {
    try {
      const buf = await fs.readFile(file);
      if (buf.length > 100) return res.type("png").send(buf);
    } catch {
      /* try next */
    }
  }
  res.status(404).end();
});

app.post("/api/computers/previews", async (_req, res) => {
  try {
    const rows = await computers.listComputers();
    const out = [];
    await Promise.all(
      rows.map(async (row) => {
        const st = await vm.inspectState(row.container);
        if (st.status !== "running") return;
        const dest = vm.computerPreviewPath(row.id);
        const shot = await vm.screenshotContainer(row.container, dest);
        out.push({ id: row.id, ok: shot.ok, error: shot.error || null });
      }),
    );
    res.json({ ok: true, shots: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/computers", async (_req, res) => {
  try {
    const docker = await vm.dockerStatus();
    const rows = docker.ok || !docker.stuck ? await liveComputers() : await staleComputers(docker);
    res.json({ computers: rows, docker });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/computers/stats", async (_req, res) => {
  try {
    const rows = await computers.listComputers();
    const stats = await vm.containerStats(rows.map((c) => c.container));
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/computers/:id", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(await computers.saveComputer({ ...row, name }));
});

async function computerBot(row) {
  const bots = await store.loadBots();
  return bots.find((b) => b.vm?.computerId === row.id) || null;
}

app.post("/api/computers/:id/:action", async (req, res) => {
  const action = req.params.action;
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const bot = await computerBot(row);
  try {
    if (action === "pause") {
      const r = await vm.pauseContainer(row.container);
      if (!r.ok) return res.status(400).json(r);
      await computers.saveComputer({ ...row, status: "paused", pausedByQuit: false });
      if (bot) {
        bot.vm = { ...bot.vm, status: "paused" };
        await store.upsertBot(bot);
        broadcast("bot", toClient(bot));
      }
    } else if (action === "resume") {
      const st = await vm.inspectState(row.container);
      if (!st.exists) {
        if (!bot) return res.status(400).json({ error: "Attach this computer to a Bot, then Start." });
        const info = await vm.startVm(bot, (m) => broadcast("log", { botId: bot.id, m }));
        bot.vm = { ...bot.vm, ...info, computerId: row.id, error: null };
        await store.upsertBot(bot);
        await computers.saveComputer({ ...row, status: "running", pausedByQuit: false, novncPort: info.novncPort });
        broadcast("bot", toClient(bot));
      } else {
        const r = await vm.resumeContainer(row.container);
        if (!r.ok) return res.status(400).json(r);
        await computers.saveComputer({ ...row, status: "running", pausedByQuit: false });
        if (bot) {
          bot.vm = { ...bot.vm, status: "running" };
          await store.upsertBot(bot);
          broadcast("bot", toClient(bot));
        }
      }
    } else if (action === "reboot") {
      const r = await vm.rebootContainer(row.container);
      if (!r.ok) return res.status(400).json(r);
      await computers.saveComputer({ ...row, status: "running", pausedByQuit: false, novncPort: r.novncPort || row.novncPort });
      if (bot) {
        bot.vm = { ...bot.vm, status: "running", novncPort: r.novncPort || bot.vm?.novncPort, error: null, hint: "" };
        await store.upsertBot(bot);
        broadcast("bot", toClient(bot));
      }
    } else if (action === "start") {
      const owner = bot || (req.body?.botId ? await store.getBot(req.body.botId) : null);
      if (!owner) return res.status(400).json({ error: "Attach this computer to a Bot first." });
      owner.vm = { ...owner.vm, computerId: row.id, container: row.container, volume: row.volume };
      const info = await vm.startVm(owner, (m) => broadcast("log", { botId: owner.id, m }));
      owner.vm = { ...owner.vm, ...info, computerId: row.id, error: null };
      await store.upsertBot(owner);
      await computers.saveComputer({
        ...row,
        status: "running",
        pausedByQuit: false,
        lastBotId: owner.id,
        novncPort: info.novncPort,
      });
      broadcast("bot", toClient(owner));
    } else if (action === "stop") {
      await vm.stopContainer(row.container);
      await computers.saveComputer({ ...row, status: "exited", pausedByQuit: false });
      if (bot) {
        bot.vm = { ...bot.vm, status: "exited" };
        await store.upsertBot(bot);
        broadcast("bot", toClient(bot));
      }
    } else if (action === "destroy") {
      await vm.stopVm({ vm: { container: row.container, volume: row.volume } }, { wipe: true });
      await computers.removeComputer(row.id);
      if (bot) {
        bot.vm = {
          status: "idle",
          container: null,
          volume: null,
          computerId: null,
          novncPort: null,
          display: ":1",
          error: null,
          detached: true,
          hint: "",
        };
        await store.upsertBot(bot);
        broadcast("bot", toClient(bot));
      }
    } else if (action === "detach") {
      if (bot && busyIds.has(bot.id)) return res.status(409).json({ error: "This Bot is mid-turn. Stop it first." });
      if (bot) {
        bot.vm = {
          ...bot.vm,
          computerId: null,
          container: null,
          volume: null,
          novncPort: null,
          status: "idle",
          detached: true,
          hint: "",
        };
        await store.upsertBot(bot);
        broadcast("bot", toClient(bot));
      }
      await computers.saveComputer({ ...row, lastBotId: bot?.id || row.lastBotId });
    } else if (action === "attach") {
      const nextBot = await store.getBot(req.body?.botId);
      if (!nextBot) return res.status(400).json({ error: "Pick a Bot." });
      if (nextBot.vm?.computerId && nextBot.vm.computerId !== row.id) {
        return res.status(409).json({ error: "That Bot already has a computer. Detach it first." });
      }
      const other = await computerBot(row);
      const share = other && other.teamId && nextBot.teamId && other.teamId === nextBot.teamId;
      if (other && other.id !== nextBot.id && !share) {
        if (busyIds.has(other.id)) return res.status(409).json({ error: `${other.name} is mid-turn. Stop it first.` });
        other.vm = {
          ...other.vm,
          computerId: null,
          container: null,
          volume: null,
          novncPort: null,
          status: "idle",
          detached: true,
          hint: "",
        };
        await store.upsertBot(other);
        broadcast("bot", toClient(other));
      }
      nextBot.vm = {
        ...(nextBot.vm || {}),
        computerId: row.id,
        container: row.container,
        volume: row.volume,
        novncPort: row.novncPort || nextBot.vm?.novncPort || null,
        status: row.status === "running" || row.status === "paused" ? row.status : nextBot.vm?.status || "idle",
        detached: false,
      };
      await store.upsertBot(nextBot);
      await computers.saveComputer({ ...row, lastBotId: nextBot.id });
      broadcast("bot", toClient(nextBot));
    } else {
      return res.status(404).json({ error: "unknown action" });
    }
    broadcast("computers", { dirty: true });
    res.json({ computers: await liveComputers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/computers/pause-all", async (_req, res) => {
  const rows = await computers.listComputers();
  const results = [];
  for (const row of rows) {
    const st = await vm.inspectState(row.container);
    if (!st.running || st.paused) continue;
    const r = await Promise.race([
      vm.pauseContainer(row.container),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 4000)),
    ]);
    if (r.ok) {
      await computers.saveComputer({ ...row, status: "paused", pausedByQuit: true });
      results.push({ id: row.id, ok: true });
    } else {
      results.push({ id: row.id, ok: false, error: r.error });
    }
  }
  res.json({ ok: true, results });
});

app.post("/api/computers/resume-quit", async (_req, res) => {
  const n = await resumePausedByQuit();
  res.json({ ok: true, resumed: n });
});

app.put("/api/vault/grants/:botId", async (req, res) => {
  const ids = await vault.setGrants(req.params.botId, req.body?.accountIds || []);
  const bot = await store.getBot(req.params.botId);
  if (bot) vault.pushListToBot(bot).catch(() => {});
  res.json({ botId: req.params.botId, accountIds: ids });
});

app.put("/api/vault/accounts/:id/grants", async (req, res) => {
  const snap = await vault.setAccountGrants(req.params.id, req.body?.botIds || []);
  if (!snap) return res.status(404).json({ error: "not found" });
  const bots = await store.loadBots();
  for (const bot of bots) vault.pushListToBot(bot).catch(() => {});
  res.json(snap);
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
      message: "Finish Grok OAuth in your Mac browser.",
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

app.get("/api/harness/local", async (_req, res) => {
  res.json(await detectLocalHarnesses({ force: true }));
});

app.get("/api/harness/status", async (_req, res) => {
  try {
    const settings = await store.loadSettings();
    res.json(await collectHarnessStatus(settings));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/harness/hermes", async (req, res) => {
  try {
    const model = String(req.body?.model || "").trim();
    if (!model) return res.status(400).json({ error: "model required" });
    const r = await hostCli.setHermesModel(model);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/harness/test", async (req, res) => {
  try {
    const settings = await store.loadSettings();
    const provider = String(req.body?.provider || "").trim() || undefined;
    const result = await pingHarness(
      settings,
      req.body?.botId ? await store.getBot(req.body.botId) : null,
      provider,
    );
    res.json({
      ...result,
      log: result.log || result.sample || result.error || "",
      at: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, log: err.message, at: Date.now() });
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
  res.json((await store.loadBots()).map((b) => toClient(b, { tail: 8 })));
});

async function publicTeams() {
  const [rows, bots] = await Promise.all([teams.listTeams(), store.loadBots()]);
  const out = [];
  for (const t of rows) {
    const messages = await teams.loadMessages(t.id);
    out.push({
      ...t,
      members: teams.membersOf(t, bots).map((b) => ({ id: b.id, name: b.name, role: b.teamRole, color: b.color })),
      messages,
    });
  }
  return out;
}

app.get("/api/teams", async (_req, res) => {
  res.json(await publicTeams());
});

app.post("/api/teams", async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "Team").trim() || "Team";
  const spec = Array.isArray(body.members) && body.members.length
    ? body.members
    : [
        { name: "Chief", role: "chief", harness: body.harness || { provider: "claude" } },
        { name: "Worker", role: "worker", harness: body.harness || { provider: "claude" } },
      ];
  const teamId = randomUUID();
  const created = [];
  let desk = null;
  for (const m of spec.slice(0, 6)) {
    const role = m.role === "chief" ? "chief" : "worker";
    const bot = store.newBot({
      name: String(m.name || role).trim() || role,
      description: role === "chief" ? `Chief of ${name}` : `Worker on ${name}`,
      harness: m.harness && typeof m.harness === "object" ? m.harness : { provider: "claude" },
      teamId,
      teamRole: role,
      avatar: m.avatar,
    });
    if (!desk) {
      desk = await computers.ensureComputerForBot(bot);
      desk = await computers.saveComputer({ ...desk, name: `${name} desk` });
    }
    bot.vm = {
      ...(bot.vm || {}),
      computerId: desk.id,
      container: desk.container,
      volume: desk.volume,
      novncPort: desk.novncPort || null,
      status: "starting",
      hint: "Starting the shared desk…",
      detached: false,
      error: null,
    };
    await store.upsertBot(bot);
    created.push(bot);
  }
  const chief = created.find((b) => b.teamRole === "chief") || created[0];
  const team = await teams.saveTeam({
    id: teamId,
    name,
    chiefId: chief?.id || null,
    memberIds: created.map((b) => b.id),
    computerId: desk?.id || null,
  });
  broadcast("bots", (await store.loadBots()).map(toClient));
  broadcast("computers", { dirty: true });
  broadcast("teams", await publicTeams());
  res.json({
    ...team,
    members: created.map((b) => ({ id: b.id, name: b.name, role: b.teamRole, color: b.color })),
    messages: [],
  });
  if (chief) provision(chief.id).catch((err) => console.log("provision", err));
});

app.delete("/api/teams/:id", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const wipe = req.body?.wipe !== false && String(req.query.wipe || "1") !== "0";
  const bots = await store.loadBots();
  const members = teams.membersOf(team, bots);
  const computerId = team.computerId || members[0]?.vm?.computerId || null;
  for (const m of members) {
    stopTurn(m.id);
    deletedIds.add(m.id);
    await store.deleteBot(m.id);
  }
  await teams.removeTeam(team.id);
  if (wipe && computerId) {
    const row = await computers.getComputer(computerId);
    if (row) {
      await vm.stopVm({ vm: { container: row.container, volume: row.volume } }, { wipe: true }).catch(() => {});
      await computers.removeComputer(row.id);
    }
  }
  sweepFromRegistry().catch((err) => console.error("sweep", err));
  broadcast("bots", (await store.loadBots()).map(toClient));
  broadcast("computers", { dirty: true });
  broadcast("teams", await publicTeams());
  res.json({ ok: true, deleted: members.map((m) => m.id), wiped: Boolean(wipe && computerId) });
});

app.post("/api/teams/:id/messages", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const text = String(req.body?.content || "").trim();
  const images = Array.isArray(req.body?.images) ? req.body.images.filter((x) => typeof x === "string").slice(0, 16) : [];
  if (!text && !images.length) return res.status(400).json({ error: "empty" });
  const posted = await teams.appendMessage(team.id, {
    role: "user",
    speakerId: "user",
    speakerName: "You",
    speakerRole: "user",
    content: text || "See attached.",
  });
  broadcast("team-message", { teamId: team.id, ...posted });
  const bots = await store.loadBots();
  const members = teams.membersOf(team, bots);
  const asked = Array.isArray(req.body?.toIds) ? req.body.toIds.map(String).filter(Boolean) : [];
  const tagged = teams.mentionedMemberIds(posted.content, members);
  const targets = [...new Set([...asked, ...tagged])].filter((id) => members.some((b) => b.id === id));
  const deliver = targets.length ? targets : [team.chiefId || team.memberIds?.[0]].filter(Boolean);
  for (const id of deliver) {
    await store.patchBot(id, (b) => {
      b.messages = b.messages || [];
      b.messages.push({ ...posted, role: "user" });
    });
    broadcast("message", { botId: id, ...posted });
    enqueueTurn(id, () => runUserTurn(id, posted.content, false, images, { persistUser: false }));
  }
  res.json({ ok: true, message: posted, toIds: deliver });
});

app.patch("/api/teams/:id", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const patch = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
  if ("section" in (req.body || {})) patch.section = String(req.body.section || "");
  if ("pinned" in (req.body || {})) patch.pinned = Boolean(req.body.pinned);
  const saved = await teams.saveTeam({ ...team, ...patch });
  broadcast("teams", await publicTeams());
  res.json(saved);
});

app.post("/api/teams/:id/focus", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const bot = await store.getBot(req.body?.botId);
  if (!bot || bot.teamId !== team.id) return res.status(404).json({ error: "not on this team" });
  const claimed = await vm.focusOwnedWindow(bot).catch(() => null);
  if (claimed && bot.vm) {
    bot.vm.windowId = claimed.windowId;
    bot.vm.windowTitle = claimed.title;
    await store.upsertBot(bot);
  }
  res.json({ ok: true, window: claimed, bot: toClient(bot) });
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
  const all = bot.messages || [];
  if (req.query.before) {
    const i = all.findIndex((m) => m.id === req.query.before);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const start = i > 0 ? Math.max(0, i - limit) : 0;
    const slice = i > 0 ? all.slice(start, i) : [];
    return res.json({
      id: bot.id,
      messages: slice.map((m) => ({ ...m, imagePath: undefined, imageB64: undefined })),
      hasMore: start > 0,
    });
  }
  const tail = Math.min(400, Math.max(1, Number(req.query.tail) || 120));
  res.json(toClient(bot, { tail }));
});

app.post("/api/bots", async (req, res) => {
  const bot = store.newBot(req.body || {});
  const row = await computers.ensureComputerForBot(bot);
  bot.vm = {
    ...bot.vm,
    computerId: row.id,
    container: row.container,
    volume: row.volume,
    status: "starting",
    hint: "Starting the computer…",
    detached: false,
    error: null,
  };
  await store.upsertBot(bot);
  broadcast("bots", (await store.loadBots()).map(toClient));
  res.json(toClient(bot));
  provision(bot.id).catch((err) => console.log("provision", err));
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
  const row = await computers.ensureComputerForBot(copy);
  copy.vm = {
    ...copy.vm,
    computerId: row.id,
    container: row.container,
    volume: row.volume,
    status: "starting",
    hint: "Starting the computer…",
    detached: false,
    error: null,
  };
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

function decorateComputer(row, bots, settings, extra = {}) {
  const byId = extra.byId || new Map(bots.map((b) => [b.id, b]));
  const attached = extra.attached || new Map(bots.filter((b) => b.vm?.computerId).map((b) => [b.vm.computerId, b]));
  const attachedBot = attached.get(row.id) || null;
  const bot = attachedBot || (row.lastBotId ? byId.get(row.lastBotId) : null);
  const owner = attachedBot || bot;
  const h = owner ? harnessFor(owner, settings) : null;
  const attachedList = extra.attachedList || (bots || []).filter((b) => b.vm?.computerId === row.id);
  const first = attachedList[0] || attachedBot;
  return {
    ...row,
    attachedBotId: first?.id || null,
    attachedBotIds: attachedList.map((b) => b.id),
    attachedBotName: attachedList.length ? attachedList.map((b) => b.name).join(", ") : attachedBot?.name || null,
    lastBotName: bot && !attachedBot ? bot.name : attachedBot?.name || null,
    previewBotId: attachedBot?.id || row.lastBotId || null,
    previewUrl: `/api/computers/${row.id}/preview`,
    color: owner?.color || null,
    harness: h
      ? { provider: h.provider, model: h.model || "", label: (HARNESS_PROVIDERS.find((p) => p.id === h.provider) || {}).label || h.provider }
      : null,
    ...extra.fields,
  };
}

async function staleComputers(docker) {
  const [rows, bots, settings] = await Promise.all([computers.listComputers(), store.loadBots(), store.loadSettings()]);
  return rows.map((row) =>
    decorateComputer(row, bots, settings, {
      fields: { stale: true, stuck: Boolean(docker?.stuck), exists: row.status !== "missing" },
    }),
  );
}

async function liveComputers() {
  const [rows, bots, settings, list] = await Promise.all([
    computers.listComputers(),
    store.loadBots(),
    store.loadSettings(),
    vm.listLocalbotStates(),
  ]);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const attached = new Map();
  for (const b of bots) {
    const cid = b.vm?.computerId;
    if (cid) attached.set(cid, b);
  }
  const out = [];
  for (const row of rows) {
    if (list.stuck) {
      out.push(decorateComputer(row, bots, settings, { byId, attached, fields: { stale: true, stuck: true, exists: row.status !== "missing" } }));
      continue;
    }
    const st = list.states.get(row.container) || { status: "missing", exists: false, running: false, paused: false };
    // Docker's current mapping wins: a port we remembered can belong to a
    // container that has since been restarted onto a different one.
    let novncPort = st.novncPort || row.novncPort || attached.get(row.id)?.vm?.novncPort || null;
    if (st.status === "running" && !novncPort) {
      novncPort = await vm.detectMappedPort(row.container);
    }
    const next = await computers.saveComputer({
      ...row,
      status: st.status,
      novncPort,
    });
    const owners = bots.filter((b) => b.vm?.computerId === row.id);
    for (const owner of owners) {
      if (novncPort && owner.vm?.novncPort !== novncPort) {
        owner.vm = { ...owner.vm, novncPort, status: st.status };
        await store.upsertBot(owner);
      }
    }
    out.push(decorateComputer(next, bots, settings, { byId, attached, fields: { status: st.status, exists: st.exists, stale: false, stuck: false } }));
  }
  return out;
}

function sweepFromRegistry() {
  return computers.listComputers().then((rows) => {
    const { keepNames, keepVolumes } = computers.keepSets(rows);
    return vm.sweepOrphans(keepNames, keepVolumes);
  });
}

app.delete("/api/bots/:id", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const keepComputer = req.body?.keepComputer !== false && String(req.query.keepComputer || "") !== "0";
  deletedIds.add(bot.id);
  const row = await computers.ensureComputerForBot(bot).catch(() => null);
  try {
    if (keepComputer) {
      if (row) await computers.saveComputer({ ...row, lastBotId: bot.id, pausedByQuit: false });
    } else {
      await vm.stopVm(bot, { wipe: true });
      if (row) await computers.removeComputer(row.id);
    }
  } catch {
    /* already gone */
  }
  if (bot.teamId) {
    const team = await teams.getTeam(bot.teamId);
    if (team) await teams.removeMember(team, bot.id);
  }
  const next = await store.deleteBot(bot.id);
  if (!next) return res.status(404).json({ error: "not found" });
  sweepFromRegistry().catch((err) => console.error("sweep", err));
  broadcast("bots", next.map(toClient));
  broadcast("computers", { dirty: true });
  broadcast("teams", await publicTeams());
  res.json({ ok: true, keepComputer: Boolean(keepComputer) });
});

app.get("/api/bots/:id/stream-health", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  try {
    const health = await vm.streamHealth(bot);
    if (health.novncPort && bot.vm?.novncPort !== health.novncPort) {
      bot.vm = { ...bot.vm, novncPort: health.novncPort };
      await store.upsertBot(bot);
      if (bot.vm.computerId) {
        const full = await computers.getComputer(bot.vm.computerId);
        if (full && full.novncPort !== health.novncPort) {
          await computers.saveComputer({ ...full, novncPort: health.novncPort });
        }
      }
      broadcast("bot", toClient(bot));
    }
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
    if (action === "reboot") {
      const row = bot.vm?.container ? { container: bot.vm.container, id: bot.vm.computerId, novncPort: bot.vm.novncPort } : await computers.ensureComputerForBot(bot);
      if (!row?.container) throw new Error("No computer to reboot.");
      bot.vm = { ...bot.vm, status: "starting", hint: "Rebooting the computer…", error: null };
      await store.upsertBot(bot);
      broadcast("bot", toClient(bot));
      const r = await vm.rebootContainer(row.container);
      if (!r.ok) throw new Error(r.error || "reboot failed");
      bot.vm = {
        ...bot.vm,
        container: row.container,
        status: "running",
        novncPort: r.novncPort || bot.vm?.novncPort,
        error: null,
        hint: "",
        detached: false,
      };
      await store.upsertBot(bot);
      if (row.id) {
        const full = await computers.getComputer(row.id);
        if (full) await computers.saveComputer({ ...full, status: "running", novncPort: bot.vm.novncPort, pausedByQuit: false });
      }
      broadcast("bot", toClient(bot));
      broadcast("computers", { dirty: true });
      return res.json(toClient(bot));
    }
    if (action === "reset") await vm.stopVm(bot, { wipe: false });
    const row = await computers.ensureComputerForBot(bot);
    bot.vm = { ...bot.vm, computerId: row.id, container: row.container, volume: row.volume, detached: false };
    const info = await vm.startVm(
      bot,
      (m) => broadcast("log", { botId: bot.id, m }),
      async () => deletedIds.has(bot.id) || !(await store.getBot(bot.id)),
    );
    bot.vm = { ...bot.vm, ...info, computerId: row.id, error: null, detached: false, hint: "" };
    await store.upsertBot(bot);
    await computers.saveComputer({
      ...row,
      status: info.status || "running",
      novncPort: info.novncPort,
      lastBotId: bot.id,
      pausedByQuit: false,
    });
    broadcast("bot", toClient(bot));
    broadcast("computers", { dirty: true });
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

function dispatchToTeammate(toId, content, from) {
  const who = from?.name || "a teammate";
  const role = from?.teamRole || "teammate";
  const prompt = `${who} (${role}) assigned you this on our shared computer:

${content}

You have the desk. One Chrome, one tab — computer action open (or chrome-desktop) replaces the current tab. Never a second tab or window. Do the work, then send_message the result so ${who} and the human both see it.`;
  enqueueTurn(toId, async () => {
    const live = await store.getBot(toId);
    if (!live) return;
    const incoming = {
      id: `u${Date.now()}tm`,
      role: "user",
      speakerId: from?.id || "teammate",
      speakerName: who,
      speakerRole: from?.teamRole || "",
      content: prompt,
      ts: Date.now(),
    };
    await store.patchBot(toId, (b) => {
      b.messages = b.messages || [];
      b.messages.push(incoming);
    });
    broadcast("message", { botId: toId, ...incoming });
    return runUserTurn(toId, prompt, false, [], { persistUser: false, replyTo: from?.id || null });
  });
}

async function deliverTeammateReply(toId, from, content) {
  if (!toId || !content || toId === from?.id) return;
  const text = `${from?.name || "Teammate"} replies:\n${content}`;
  const incoming = {
    id: `a${Date.now()}rp`,
    role: "assistant",
    speakerId: from?.id,
    speakerName: from?.name,
    speakerRole: from?.teamRole || "",
    content: text,
    ts: Date.now(),
  };
  const liveBot = await store.patchBot(toId, (b) => {
    b.messages = b.messages || [];
    b.messages.push(incoming);
  });
  if (!liveBot) return;
  broadcast("message", { botId: toId, ...incoming });
  const live = inflightTurns.get(toId);
  if (live) live.nudges.push(text);
  else enqueueTurn(toId, () => runUserTurn(toId, text, false, [], { persistUser: false }));
}

setTeamDispatch(dispatchToTeammate);
setTeamReply(deliverTeammateReply);
setStopBot((id) => {
  stopTurn(id);
  deletedIds.add(id);
});

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
  if (!on) {
    enqueueTurn(bot.id, () =>
      runUserTurn(
        bot.id,
        "The user released the computer. Screenshot and continue what you were doing. If you were idle, just confirm you have the desktop again.",
        false,
        [],
        { persistUser: false },
      ),
    );
  }
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

app.delete("/api/bots/:id/messages/:mid", async (req, res) => {
  const extra = String(req.query.ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [...new Set([req.params.mid, ...extra].filter(Boolean))];
  const bot = await store.deleteMessages(req.params.id, ids);
  if (!bot) return res.status(404).json({ error: "not found" });
  broadcast("bot", toClient(bot));
  res.json(toClient(bot));
});

app.post("/api/bots/:id/messages", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const text = String(req.body?.content || "").trim();
  const images = Array.isArray(req.body?.images) ? req.body.images.filter((x) => typeof x === "string").slice(0, 16) : [];
  if (!text && !images.length) return res.status(400).json({ error: "empty" });
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
  const live = inflightTurns.get(bot.id);
  const busy = busyIds.has(bot.id) && live;
  if (busy) {
    live.nudges.push(userMsg.content);
    res.json({ ok: true, queued: true });
    return;
  }
  res.json({ ok: true, queued: false });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, userMsg.content, false, images, { persistUser: false }));
});

app.post("/api/bots/:id/choice", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const messageId = String(req.body?.messageId || "");
  const choiceId = String(req.body?.choiceId || "");
  const custom = String(req.body?.custom || "").trim();
  const card = (bot.messages || []).find((m) => m.id === messageId && m.kind === "choices");
  if (!card || card.pending === false) return res.status(400).json({ error: "choice is not open" });
  const picked = (card.choices || []).find((c) => String(c.id) === choiceId);
  const label = custom || picked?.label || "";
  if (!label) return res.status(400).json({ error: "pick an option or type one" });
  const describe = /i'?ll describe/i.test(label);
  if (describe && !custom) return res.status(400).json({ error: "type what this Bot should do" });
  card.pending = false;
  card.selected = { id: choiceId || "custom", label };
  const intent = card.context?.intent;
  const name = card.context?.name || "Worker";
  if (intent === "create-teammate" && !describe) {
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
    }
    const { bot: mate, team: saved } = await teams.addMember(team, {
      name,
      job: label,
      role: "worker",
      harness: bot.harness,
    });
    bot.teamId = saved.id;
    await store.upsertBot(bot);
    const userMsg = {
      id: `u${Date.now()}ch`,
      role: "user",
      content: label,
      ts: Date.now(),
    };
    const note = {
      id: `a${Date.now()}nb`,
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      content: `Created ${mate.name} to ${label}. They’re on this desk — switch to their tab to watch them.`,
      ts: Date.now(),
    };
    await store.patchBot(bot.id, (b) => {
      b.messages = b.messages || [];
      const live = b.messages.find((m) => m.id === card.id);
      if (live) {
        live.pending = false;
        live.selected = card.selected;
      }
      b.messages.push(userMsg, note);
      b.teamId = saved.id;
      b.teamRole = b.teamRole || "chief";
    });
    broadcast("message", { botId: bot.id, ...userMsg });
    broadcast("message", { botId: bot.id, ...note });
    broadcast("bots", (await store.loadBots()).map(toClient));
    return res.json({ ok: true, created: { id: mate.id, name: mate.name }, team: saved });
  }
  const userMsg = {
    id: `u${Date.now()}ch`,
    role: "user",
    content: label,
    ts: Date.now(),
  };
  await store.patchBot(bot.id, (b) => {
    b.messages = b.messages || [];
    const live = b.messages.find((m) => m.id === card.id);
    if (live) {
      live.pending = false;
      live.selected = card.selected;
    }
    b.messages.push(userMsg);
  });
  broadcast("message", { botId: bot.id, ...userMsg });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, label, false, [], { persistUser: false }));
  res.json({ ok: true, queued: busyIds.has(bot.id) });
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
  const body = req.body || {};
  const minutes = Number(body.interval_minutes ?? body.intervalMinutes);
  const explicitInterval = Number.isFinite(minutes) && minutes > 0;
  const intervalProvided = Object.prototype.hasOwnProperty.call(body, "interval_minutes") || Object.prototype.hasOwnProperty.call(body, "intervalMinutes");
  const hasTriggers = Array.isArray(body.triggers) && body.triggers.length;
  if (typeof body.instruction === "string" && routines.isRejectedRoutineInstruction(body.instruction, { explicitInterval: explicitInterval || hasTriggers })) {
    return res.status(400).json({ error: "routine instruction is not a standing scheduled job" });
  }
  if (intervalProvided && !explicitInterval) {
    return res.status(400).json({ error: "invalid routine interval" });
  }
  if (!explicitInterval && !hasTriggers && body.schedule != null && !routines.normalizeSchedule(body.schedule)) {
    return res.status(400).json({ error: "invalid routine schedule" });
  }
  const settings = await store.loadSettings();
  let result;
  const live = await store.patchBot(req.params.id, (bot) => {
    result = routines.upsertRoutine(bot, {
      name: body.name,
      instruction: body.instruction,
      groupKey: body.group_key || body.groupKey,
      intervalMs: explicitInterval ? minutes * 60_000 : body.intervalMs,
      schedule: body.schedule,
      triggers: body.triggers,
      forceNew: body.force_new === true,
      solo: body.solo !== false,
      timeZone: resolveZone(settings),
    });
  });
  if (!live) return res.status(404).json({ error: "not found" });
  if (result?.rejected && !result.routine) return res.status(400).json(result);
  broadcast("bot", toClient(live));
  res.json(result);
});

app.patch("/api/bots/:id/routines/:rid", async (req, res) => {
  const body = req.body || {};
  const settings = await store.loadSettings();
  const minutes = Number(body.interval_minutes ?? body.intervalMinutes);
  const explicitInterval = Number.isFinite(minutes) && minutes > 0;
  const intervalProvided = Object.prototype.hasOwnProperty.call(body, "interval_minutes") || Object.prototype.hasOwnProperty.call(body, "intervalMinutes");
  if (intervalProvided && !explicitInterval) {
    return res.status(400).json({ error: "invalid routine interval" });
  }
  if (!explicitInterval && !Array.isArray(body.triggers) && body.schedule != null && !routines.normalizeSchedule(body.schedule)) {
    return res.status(400).json({ error: "invalid routine schedule" });
  }
  let updated = null;
  let missing = false;
  const live = await store.patchBot(req.params.id, (bot) => {
    if (!Array.isArray(bot.routines)) bot.routines = [];
    const r = bot.routines.find((x) => x.id === req.params.rid);
    if (!r) {
      missing = true;
      return;
    }
    if (typeof body.name === "string") r.name = body.name.trim() || r.name;
    if (typeof body.instruction === "string") r.instruction = body.instruction;
    if (typeof body.group_key === "string" || typeof body.groupKey === "string") {
      r.groupKey = body.group_key || body.groupKey;
    }
    if (Array.isArray(body.triggers)) {
      r.triggers = body.triggers.map(routines.normalizeTrigger).filter(Boolean).map((t) => ({
        ...t,
        id: t.id || randomUUID(),
      }));
      routines.syncLegacyFromTriggers(r, Date.now(), resolveZone(settings));
    } else if (Number.isFinite(minutes) && minutes > 0) {
      r.intervalMs = minutes * 60_000;
      delete r.schedule;
      delete r.nextRunAt;
      delete r.nextRunTimeZone;
      delete r.triggers;
    } else if (body.schedule != null) {
      const schedule = routines.normalizeSchedule(body.schedule);
      const previous = routines.normalizeSchedule(r.schedule);
      const unchanged =
        previous &&
        previous.type === schedule.type &&
        previous.hour === schedule.hour &&
        previous.minute === schedule.minute &&
        Number.isFinite(r.nextRunAt);
      r.schedule = schedule;
      delete r.intervalMs;
      delete r.triggers;
      const now = Date.now();
      r.nextRunAt = unchanged
        ? routines.calendarNextRunAt(r, now, resolveZone(settings))
        : routines.nextCalendarOccurrence(now, schedule, resolveZone(settings));
      r.nextRunTimeZone = resolveZone(settings);
    }
    if (typeof body.enabled === "boolean") r.enabled = body.enabled;
    r.updatedAt = Date.now();
    updated = r;
  });
  if (!live) return res.status(404).json({ error: "not found" });
  if (missing) return res.status(404).json({ error: "routine not found" });
  broadcast("bot", toClient(live));
  res.json(updated);
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

app.post("/api/bots/:id/routines/:rid/run", async (req, res) => {
  const bot = await store.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  const routine = (bot.routines || []).find((r) => r.id === req.params.rid);
  if (!routine) return res.status(404).json({ error: "routine not found" });
  const now = Date.now();
  await store.patchBot(bot.id, (live) => {
    const r = (live.routines || []).find((x) => x.id === routine.id);
    if (!r) return;
    r.lastRunAt = now;
    r.updatedAt = now;
    r.runs = [...(Array.isArray(r.runs) ? r.runs : []), { ts: now, kind: "test" }].slice(-24);
  });
  const prompt = `Standing routine "${routine.name || "Routine"}" was started with Test run. Do this work now, then stop if nothing changed:\n${routine.instruction || ""}`;
  enqueueTurn(bot.id, () => runUserTurn(bot.id, prompt, true));
  broadcast("bot", toClient(await store.getBot(bot.id)));
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

async function runUserTurn(botId, text, hidden, images = [], opts = {}) {
  const ac = new AbortController();
  turnAbort.set(botId, ac);
  busyIds.add(botId);
  const bag = { nudges: [] };
  inflightTurns.set(botId, bag);
  try {
    let bot = await store.getBot(botId);
    if (!bot) return;
    const mapped = bot.vm?.container ? (vm.cachedMappedPort(bot.vm.container) || (await vm.detectMappedPort(bot.vm.container))) : null;
    const port = vm.resolveStreamPort(bot.vm?.novncPort, mapped);
    if (port && bot.vm && bot.vm.novncPort !== port) {
      bot.vm = { ...bot.vm, novncPort: port };
      await store.upsertBot(bot);
    }
    broadcast("bot", toClient(bot));
    const box = bot.vm?.container;
    const chromeOk = box ? await vm.chromeReady(box) : false;
    const setup = bot.vm?.setup;
    if (!chromeOk || bot.vm?.status === "starting" || (setup && setup.ready === false)) {
      const step =
        !setup?.ready && setup?.step && setup.total ? ` (${setup.step}/${setup.total}: ${setup.label || "starting"})` : "";
      const waitMsg = {
        id: `a${Date.now()}wait`,
        role: "assistant",
        content: setup?.ready
          ? "Chrome is not ready yet. I'll start as soon as it is."
          : `The computer is still setting up${step}. I'll start as soon as Chrome is ready.`,
        ts: Date.now(),
      };
      bot.messages = bot.messages || [];
      bot.messages.push(waitMsg);
      await store.upsertBot(bot);
      broadcast("message", { botId, ...waitMsg });
      broadcast("bot", toClient(bot));
    }
    const ready = await vm.waitForDesktop(bot, {
      timeoutMs: 480_000,
      onLog: (m) => noteVm(botId, m),
      shouldAbort: async () => ac.signal.aborted || deletedIds.has(botId),
    });
    if (ac.signal.aborted) return;
    bot = await store.getBot(botId);
    if (bot) {
      if (ready.ok) {
        bot.vm = {
          ...bot.vm,
          ...(ready.health || {}),
          status: "running",
          error: null,
          hint: "",
          setup: ready.setup || { step: 4, total: 4, label: "Ready", ready: true },
        };
      } else {
        bot.vm = {
          ...bot.vm,
          status: "starting",
          error: ready.reason || null,
          hint: ready.reason || bot.vm?.hint,
          setup: ready.setup || bot.vm?.setup,
        };
      }
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
          content: /app install|wget|apt|PackageKit|Unable to fetch/i.test(ready.reason || "")
            ? "The computer is still installing Chrome and tools. I’ll keep going once it’s ready."
            : ready.reason || "Computer is not ready yet.",
          ts: Date.now(),
        });
        await store.upsertBot(live);
        broadcast("bot", toClient(live));
      }
      return;
    }
    bot = await store.getBot(botId);
    const settings = await store.loadSettings();
    settings.__internalToken = internalToken;
    settings.__port = PORT;
    settings.__replyTo = opts.replyTo || null;
    settings.__didReply = false;
    await runTurn({
      bot,
      settings,
      userText: text,
      hidden,
      images,
      persistUser: opts.persistUser !== false,
      signal: ac.signal,
      pullNudges: () => bag.nudges.splice(0),
      emit: (event, data) => {
        broadcast(event, { botId, ...data });
        if (event === "routine" || event === "message") return store.upsertBot(bot);
      },
    });
    if (opts.replyTo && !settings.__didReply) {
      const latest = await store.getBot(botId);
      const last = [...(latest?.messages || [])].reverse().find((m) => m.role === "assistant" && String(m.content || "").trim() && m.kind !== "choices");
      if (last) await deliverTeammateReply(opts.replyTo, latest, last.content);
    }
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
    const leftover = bag.nudges.splice(0);
    if (turnAbort.get(botId) === ac) turnAbort.delete(botId);
    inflightTurns.delete(botId);
    busyIds.delete(botId);
    const live = await store.getBot(botId);
    if (live) broadcast("bot", toClient(live));
    if (leftover.length && !ac.signal.aborted) {
      enqueueTurn(botId, () => runUserTurn(botId, leftover.join("\n"), false, [], { persistUser: false }));
    }
  }
}

async function tickRoutines() {
  const bots = await store.loadBots();
  const now = Date.now();
  const settings = await store.loadSettings();
  const timeZone = resolveZone(settings);
  for (const original of bots) {
    let bot = original;
    if (isHumanControl(bot.id)) continue;
    const snapshot = (bot.routines || []).map((r) => ({
      intervalMs: r.intervalMs,
      schedule: r.schedule,
      nextRunAt: r.nextRunAt,
      triggers: JSON.stringify(r.triggers || []),
    }));
    for (const r of bot.routines || []) {
      routines.hydrateRoutine(r, now, timeZone);
      if (Array.isArray(r.triggers) && r.triggers.length) {
        for (const t of r.triggers) {
          if (!Number.isFinite(t.nextRunAt) || t.nextRunAt <= 0) {
            t.nextRunAt = routines.nextTriggerOccurrence(t, now, timeZone);
          }
        }
        continue;
      }
      if (!routines.isCalendarRoutine(r)) continue;
      const next = routines.calendarNextRunAt(r, now, timeZone);
      if (Number.isFinite(next) && next !== r.nextRunAt) {
        r.nextRunAt = next;
        r.nextRunTimeZone = timeZone;
      }
    }
    const dirty = (bot.routines || []).some((r, i) => {
      const prev = snapshot[i];
      return prev.intervalMs !== r.intervalMs || JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule) || prev.nextRunAt !== r.nextRunAt || prev.triggers !== JSON.stringify(r.triggers || []);
    });
    if (dirty) {
      bot =
        (await store.patchBot(bot.id, (live) => {
          for (const r of live.routines || []) {
            routines.hydrateRoutine(r, now, timeZone);
            if (Array.isArray(r.triggers) && r.triggers.length) {
              for (const t of r.triggers) {
                if (!Number.isFinite(t.nextRunAt) || t.nextRunAt <= 0) {
                  t.nextRunAt = routines.nextTriggerOccurrence(t, now, timeZone);
                }
              }
              continue;
            }
            if (!routines.isCalendarRoutine(r)) continue;
            const next = routines.calendarNextRunAt(r, now, timeZone);
            if (Number.isFinite(next) && next !== r.nextRunAt) {
              r.nextRunAt = next;
              r.nextRunTimeZone = timeZone;
              r.updatedAt = now;
            }
          }
        })) || bot;
    }
    const due = routines.dueRoutines(bot, now, { timeZone });
    if (!due.length) continue;
    const packs = routines.packDue(due);
    for (const pack of packs) {
      const accepted = [];
      await store.patchBot(bot.id, (live) => {
        const currentDue = new Map(routines.dueRoutines(live, now, { timeZone }).map((r) => [r.id, r]));
        for (const id of pack.ids) {
          const r = currentDue.get(id);
          if (r) {
            r.lastRunAt = now;
            if (Array.isArray(r.triggers) && r.triggers.length) {
              for (const t of r.triggers) {
                if (routines.triggerDue(t, now, timeZone)) routines.advanceTrigger(t, now, timeZone);
              }
            } else if (routines.isCalendarRoutine(r)) routines.advanceCalendarRoutine(r, now, timeZone);
            r.updatedAt = now;
            r.runs = [...(Array.isArray(r.runs) ? r.runs : []), { ts: now }].slice(-24);
            accepted.push(r);
          }
        }
      });
      if (!accepted.length) continue;
      const live = (await store.getBot(bot.id)) || bot;
      const prompt = await memory.routineFirePrompt(live, accepted, now, timeZone).catch(
        () =>
          `Standing routine "${accepted[0].name}" is due (repeating job, run ${(accepted[0].runs || []).length || 1}). Continue from previous progress. Do not start over.\n${accepted[0].instruction || ""}`,
      );
      enqueueTurn(bot.id, () => runUserTurn(bot.id, prompt, true));
    }
  }
}

setInterval(() => tickRoutines().catch((e) => console.error("routines", e)), 15_000);

const provisioning = new Set();

function noteVm(id, hint) {
  broadcast("log", { botId: id, m: hint });
}

async function provision(id) {
  if (deletedIds.has(id) || provisioning.has(id)) return;
  provisioning.add(id);
  const bot = await store.patchBot(id, (live) => {
    live.vm = { ...live.vm, status: "starting", error: null, hint: "Starting the computer…", detached: false };
  });
  if (!bot) {
    provisioning.delete(id);
    return;
  }
  broadcast("bot", toClient(bot));
  try {
    const row = await computers.ensureComputerForBot(bot);
    const ready = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, computerId: row.id, container: row.container, volume: row.volume, detached: false };
    });
    if (ready) {
      Object.assign(bot.vm, ready.vm);
      broadcast("bot", toClient(ready));
    }
    const info = await vm.startVm(
      bot,
      (m) => noteVm(id, m),
      async () => deletedIds.has(id) || !(await store.getBot(id)),
    );
    const live = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, ...info, computerId: row.id, error: null, hint: "" };
    });
    await computers.saveComputer({
      ...row,
      status: info.status || "running",
      novncPort: info.novncPort,
      lastBotId: id,
      pausedByQuit: false,
    });
    if (live) {
      vault.pushListToBot(live).catch(() => {});
      broadcast("bot", toClient(live));
      vm.screenshotContainer(info.container, vm.computerPreviewPath(row.id)).catch(() => {});
    }
  } catch (err) {
    const transient = /app install|Unable to fetch|apt|wget|PackageKit|warming|not become/i.test(err.message || "");
    const live = await store.patchBot(id, (b) => {
      b.vm = {
        ...b.vm,
        status: transient ? "starting" : "error",
        error: transient ? null : err.message,
        hint: transient ? "Still setting up the computer…" : err.message,
      };
    });
    if (live) broadcast("bot", toClient(live));
  } finally {
    provisioning.delete(id);
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(root, "web", "index.html"));
});

async function resumePausedByQuit() {
  const rows = await computers.listComputers();
  let n = 0;
  for (const row of rows) {
    if (!row.pausedByQuit) continue;
    const r = await vm.resumeContainer(row.container);
    if (r.ok) {
      await computers.saveComputer({ ...row, status: "running", pausedByQuit: false });
      n += 1;
    }
  }
  return n;
}

async function ensureDesktops() {
  const dock = await vm.dockerStatus();
  if (!dock.ok) return dock;
  const [bots, list] = await Promise.all([store.loadBots(), vm.listLocalbotStates()]);
  if (list.stuck) return dock;
  for (const bot of bots) {
    if (deletedIds.has(bot.id) || isHumanControl(bot.id) || provisioning.has(bot.id)) continue;
    if (!bot.vm?.computerId) {
      if (bot.vm?.detached) continue;
      provision(bot.id).catch((err) => console.error("ensure desktop", bot.id, err));
      continue;
    }
    const st = bot.vm?.status;
    const name = bot.vm?.container;
    const liveBox = name ? list.states.get(name) : null;
    if (name && (st === "running" || st === "starting") && liveBox && !liveBox.running && !liveBox.paused && liveBox.exists) {
      provision(bot.id).catch((err) => console.error("ensure desktop", bot.id, err));
      continue;
    }
    if (st === "starting" || (bot.vm?.setup && bot.vm.setup.ready === false)) {
      if (name && (await vm.chromeReady(name))) {
        const live = await store.patchBot(bot.id, (b) => {
          b.vm = {
            ...b.vm,
            status: "running",
            hint: "",
            error: null,
            setup: { step: 4, total: 4, label: "Ready", ready: true },
          };
        });
        if (live) {
          broadcast("bot", toClient(live));
          broadcast("log", { botId: bot.id, m: "Computer is ready." });
        }
        continue;
      }
      if (name && (vm.setupProgress(name).step || 0) > 0) continue;
    }
    if (st === "running" || st === "paused" || st === "exited" || st === "stopped") continue;
    provision(bot.id).catch((err) => console.error("ensure desktop", bot.id, err));
  }
  return dock;
}

const httpServer = app.listen(PORT, "127.0.0.1", async () => {
  console.log(`Sub8 http://127.0.0.1:${PORT}`);
  try {
    const bots = await store.loadBots();
    const mig = await computers.migrateFromBots(bots, {
      containerName: vm.containerName,
      configVolume: vm.configVolume,
    });
    if (mig.botsChanged.length) {
      for (const id of mig.botsChanged) {
        const b = bots.find((x) => x.id === id);
        if (b) await store.upsertBot(b);
      }
    }
    const gone = await sweepFromRegistry();
    if (gone.length) console.log("swept orphan computers", gone.join(", "));
    const n = await resumePausedByQuit();
    if (n) console.log(`resumed ${n} computer${n === 1 ? "" : "s"} paused on last quit`);
  } catch (err) {
    console.error("startup computers", err);
  }
  ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  setInterval(() => {
    ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  }, 12_000);
  vault.startVaultBridge(() => store.loadBots());
});
httpServer.on("error", (err) => {
  console.error(`listen ${PORT}`, err.message || err);
  process.exit(1);
});
