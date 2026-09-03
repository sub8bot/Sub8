import express from "express";
import type { ErrorMiddleware } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as store from "@sub8/store";
import * as vm from "./vm.mjs";
import * as routines from "@sub8/automations";
import { runTurn, publicBot, pingHarness, webSearch, orchestratorReply, HARNESS_PROVIDERS, harnessFor, setTeamDispatch, setTeamReply, setStopBot, setEndTurn } from "./agent.mjs";
import { detectLocalHarnesses } from "./local-llm.mjs";
import { collectHarnessStatus } from "./harness-status.mjs";
import * as identities from "./identities.mjs";
import type { Identity } from "@sub8/identities";
import { applySimulate } from "../web/brain-setup.mjs";
import { looksLikeAuthFailure, rewriteHarnessOutput } from "@sub8/harness-auth";
import { randomBytes, randomUUID } from "node:crypto";
import { setHumanControl, isHumanControl, releaseHumanControl, boxHelpReleasedWake } from "@sub8/control";
import { appRoot, dataDir } from "./paths.mjs";
import * as appUpdate from "./update.mjs";
import * as vault from "./vault.mjs";
import * as vaultSync from "./vault-sync.mjs";
import * as computers from "./computers.mjs";
import * as deskImages from "./desk-images.mjs";
import { copyArchiveToDesk, identityStamp, stampAgentsMdShell } from "./move-to-cloud.mjs";
import * as hostCli from "./host-cli.mjs";
import { resolveZone } from "./context.mjs";
import * as teams from "./teams.mjs";
import * as channels from "@sub8/store/channels";
import { syncChannelDesk } from "./channel-desk.mjs";
import { resolveStreamPort, streamPortForDisplay } from "@sub8/desk-ports";
import * as teammate from "./teammate.mjs";
import * as subagents from "./subagents.mjs";
import * as codeAgent from "./code-agent.mjs";
import {
  takeWakeOfType,
  takeWakeById,
  subscribeWakes as subscribeDurableWakes,
  AUTO_DRAIN_WAKE_TYPES,
  turnPromptForWake,
  enqueueWake,
  requeueWake,
} from "@sub8/wakes";
import * as memory from "./memory.mjs";
import * as account from "./account.mjs";
import * as cloudDraft from "./cloud/draft.mjs";
import { resolveChoice, visibleChoiceReply, applyInternalEmit } from "@sub8/choice";
import * as spendGuard from "./spend-guard.mjs";
import * as mcpRemote from "@sub8/web-fetch/mcp-remote";

import type { Request, Response } from "express";
import type { AgentSettings, RunTurnOptions } from "./agent.mjs";
import type { ContextSettings } from "./context.mjs";
import type { HarnessStatus } from "../web/brain-setup.mjs";
import type { ChoiceBot, ChoiceRow } from "@sub8/choice";
import type { Wake, WakePayload } from "@sub8/wakes";

/**
 * One chat row as this file writes it. `@sub8/store`'s `Message` carries an
 * index signature, so `kind`, `pending` and `ts` come back `unknown` to anyone
 * who names them; `server/agent.mts`'s `AgentMessage` and `@sub8/wakes`'
 * `TurnMessage` name them without `| undefined`. The intersection is the same
 * row spelled so both sides accept it.
 */
type IndexMessage = store.Message & {
  role?: string;
  kind?: string;
  content?: string;
  name?: string;
  hidden?: boolean;
  pending?: boolean;
  ts?: number;
  summary?: string;
  toolCallId?: string;
  speakerId?: string;
  speakerName?: string;
  speakerRole?: string;
  toId?: string;
  toName?: string;
};

/**
 * The stored bot row as the modules this file hands it to want it spelled.
 *
 * Not one new field on disk. `@sub8/store` models a bot with an index signature
 * and spells `vm.container` `string | null | undefined`, while `server/vm.mts`,
 * `server/agent.mts`, `server/vault.mts`, `server/computers.mts` and
 * `@sub8/automations` each name their own slice of the same row without the
 * `null` and without the index signature — every one of them reads those fields
 * with a truthiness check, so a null behaves as the absence it is. The same
 * object satisfies all of them at runtime; only the optional-property spelling
 * differs, so the `as IndexBot` on each row loaded below restates what the store
 * already wrote and emits no instruction.
 */
type IndexBot = store.Bot & {
  name?: string;
  description?: string;
  instructions?: string;
  color?: string;
  teamId?: string;
  teamRole?: string;
  section?: string;
  grokSessionId?: string;
  harnessSessionId?: string;
  harnessSessionFresh?: boolean;
  harness?: store.BotHarness & { provider?: string; model?: string };
  vm?: (store.BotVm & {
    // Detach and destroy blank these with `null`; every reader treats that as
    // the absence it is. The rest are fields @sub8/store leaves under its index
    // signature, which would otherwise read back `unknown`.
    computerId?: string | null | undefined;
    harnessPort?: number | null | undefined;
    debugPort?: number | undefined;
    deskUrl?: string | undefined;
    windowId?: string | undefined;
    windowTitle?: string | undefined;
    detached?: boolean | undefined;
    hint?: string | undefined;
    setup?: vm.SetupProgress | undefined;
  }) | undefined;
  messages: IndexMessage[];
  routines?: (store.StoredRoutine & memory.MemoryRoutine)[];
  awaitingUserSelection?: boolean;
};

/**
 * The same row as `server/agent.mts` spells it. That file's `AgentBot` is not
 * exported — it is the widest of the several slices of a bot record and never
 * meant as an import — so this names it through the one function that takes it.
 */
type AgentBotRow = Parameters<typeof publicBot>[0];

/**
 * The little a dispatch reads off the bot that sent it. Named separately so the
 * two hooks below take both this file's row and agent.mts's, which is what
 * `setTeamDispatch` and `setTeamReply` hand them.
 */
interface DispatchFrom {
  id?: string;
  name?: string;
  teamId?: string;
  teamRole?: string;
}

/**
 * One remembered bot, as `collectRecoverHints` rebuilds it from the computers
 * registry and the team message log. `store.recoverMissingBots` takes these.
 */
interface RecoverHint {
  id: string;
  name?: string;
  teamId?: string;
  teamRole?: string;
  harness?: store.BotHarness;
  vm?: store.BotVm;
  [key: string]: unknown;
}

/** One routine read back off a desk by `restoreDeskAutomations`. */
interface RestoredRoutine {
  id?: string | undefined;
  name: string;
  instruction: string;
  intervalMs?: number | undefined;
  /** @sub8/automations' own `DailySchedule`; the store models it open. */
  schedule?: routines.DailySchedule | undefined;
  enabled: boolean;
  groupKey: string;
  createdAt: number;
  updatedAt: number;
}

/** The three fields `POST /api/cloud/draft/bots/:id/messages` forwards on. */
interface CloudTurnReply {
  turnId?: unknown;
  userMessage?: unknown;
  reply?: { userMessage?: unknown } | undefined;
}

/** What a turn is told about the message that started it. */
interface TurnOptions {
  persistUser?: boolean | undefined;
  replyTo?: string | null | undefined;
  /** What started the turn: a user message ("user", the default) or a
   * teammate's report ("report"). A chief's plain reply is mirrored into the
   * team channel only for user turns — the user already sees the worker's
   * reply, so a report turn speaks only via send_message. */
  source?: "user" | "report" | undefined;
}

/**
 * What `toClient` is asked for on top of the stored row.
 *
 * `toClient`'s own parameter is `unknown`, not this, because ten call sites are
 * `bots.map(toClient)` — which hands the array index in as the second argument.
 * A number has no `tail`, so those calls take the default of 24 and spread to
 * nothing, which is what they have always done.
 */
interface ToClientOptions {
  tail?: number | undefined;
}

// routines.mjs used to reach for vm.mjs with a lazy import; @sub8/automations
// takes the desk filesystem by injection instead.
routines.setAutomationWriter(vm);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = appRoot;
const PORT = Number(process.env.PORT || 8787);
if (!process.env.PORT) process.env.PORT = String(PORT);

const app = express();
app.use(express.json({ limit: "8mb" }));
// express 5 leaves req.body UNDEFINED for a request it did not parse (no JSON
// content-type); express 4 handed back {}. Fifteen routes dereference
// req.body.<prop> directly, so each was a 500 on a request without the header —
// PUT /api/settings answered "TypeError: Cannot read properties of undefined
// (reading 'harness')". Eighteen other sites already write `req.body || {}`,
// which is the express 4 assumption spelled out. Normalising once here fixes
// the class instead of the fifteen, and makes both spellings correct.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
/**
 * Refuse state-changing requests that a foreign web page sent.
 *
 * This server binds 127.0.0.1 and only the four /api/internal/* routes check a
 * token, so loopback was the entire boundary. It is not one against a page the
 * user merely visits: a cross-origin `<form method="POST">` needs no CORS
 * preflight, and several destructive routes need no body and no header a
 * browser withholds — `/api/computers/pause-all` (pauses every desk),
 * `/api/docker/recover` (restarts Colima, taking down every container),
 * `/api/bots` and `/api/teams` (create bots and provision containers). Each
 * takes `_req` or runs correctly from `{}`, so the form's unparsed body was no
 * obstacle, and the opaque response does not matter when the harm is the side
 * effect.
 *
 * Origin is the right discriminator: browsers attach it to every cross-origin
 * POST, and a non-browser caller (the Electron shell, mcp-sub8 over
 * SUB8_INTERNAL_URL, curl) sends none. So absent Origin passes and a foreign
 * one is refused — no token to distribute, and same-origin app traffic is
 * unaffected.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function sameOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.port !== String(PORT)) return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  const method = String(req.method || "");
  if (!MUTATING.has(method) || !origin || sameOrigin(origin)) return next();
  console.warn(`[api] refused cross-origin ${method} ${req.url} from ${origin}`);
  res.status(403).json({ ok: false, error: "cross-origin request refused" });
});

/**
 * The vault routes hand back plaintext credentials, and until now any GET
 * reached them: the middleware above exempts non-mutating methods, and this
 * server assumed "binds 127.0.0.1" meant only the desktop UI could knock. It
 * does not. A bot's container reaches the host through the VM's gateway
 * (192.168.5.2 on Lima), so `curl .../api/vault/accounts/<id>/reveal` from
 * inside a box returned passwords for accounts that box was never granted.
 *
 * This is a barrier, NOT the boundary. A browser fetch always carries
 * Sec-Fetch-Site (a forbidden header name, so page script cannot spoof it) or
 * at least a same-origin Referer; curl carries neither unless it is told to.
 * A determined caller can still set them by hand. The real fix is to stop
 * treating loopback as an identity -- bots must not reach the host API, or the
 * reveal must be authorised against the calling bot's grants. Both are design
 * calls, so this closes the demonstrated path without pretending to be more.
 */
function fromBrowser(req: Request): boolean {
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site) return site === "same-origin" || site === "none";
  const referer = String(req.headers.referer || "");
  if (!referer) return false;
  try {
    return sameOrigin(new URL(referer).origin);
  } catch {
    return false;
  }
}

app.use("/api/vault", (req, res, next) => {
  if (fromBrowser(req)) return next();
  console.warn(`[api] refused non-browser ${req.method} /api/vault${req.url}`);
  res.status(403).json({ ok: false, error: "vault is reachable from the app only" });
});
app.use("/screens", express.static(path.join(dataDir, "screens")));
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three")));

const busyIds = new Set();
function loadOrCreateInternalToken() {
  const p = path.join(dataDir, "internal-token");
  try {
    const existing = String(readFileSync(p, "utf8") || "").trim();
    if (/^[0-9a-f]{48}$/i.test(existing)) return existing;
  } catch {
    /* first boot */
  }
  const t = randomBytes(24).toString("hex");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(p, t, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* still run with in-memory token */
  }
  return t;
}
const internalToken = String(process.env.SUB8_INTERNAL_TOKEN || "").trim() || loadOrCreateInternalToken();
process.env.SUB8_INTERNAL_TOKEN = internalToken;
process.env.SUB8_INTERNAL_URL = `http://127.0.0.1:${PORT}`;
function toClient(bot: store.Bot, opts: unknown = {}) {
  const mapped = bot.vm?.container ? vm.cachedMappedPort(bot.vm.container) : null;
  const portMap = bot.vm?.container ? vm.cachedPortMap(bot.vm.container) : null;
  const n = vm.displayNum(bot as vm.Bot);
  const novncPort = streamPortForDisplay(n, portMap || (mapped ? { 3000: mapped } : null), bot.vm?.novncPort);
  const client = publicBot(bot as AgentBotRow, { tail: (opts as ToClientOptions).tail ?? 24, ...(opts as ToClientOptions) });
  if (client.vm) {
    client.vm = {
      ...client.vm,
      display: bot.vm?.display || ":1",
      debugPort: bot.vm?.debugPort || vm.debugPortFor(n),
      novncPort: novncPort || null,
      // `AgentBotVm` names only what agent.mts reads, and `debugPort` is read by
      // the browser, not by that file. The assertion restates the object the
      // three lines above just built and emits nothing.
    } as NonNullable<typeof client.vm>;
  }
  return {
    ...client,
    busy: busyIds.has(bot.id),
    storage: {
      sessionId: bot.id,
      harnessSessionId: bot.harnessSessionId || bot.grokSessionId || bot.id,
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
      if (/\.(html|js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-store");
    },
  }),
);

const clients = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
  // The attention event: a bot just asked the human for something (a pick, a
  // credential, a verification code). One structural hook — every card funnels
  // through broadcast — so the desktop app can toast + fire a native macOS
  // notification, and future surfaces (menu bar, iOS) subscribe to the same
  // event. This is the start of the event vocabulary: attention now; done /
  // error / needs-review later.
  if (event === "message") {
    const m = data as { botId?: string; kind?: string; pending?: boolean; content?: string; question?: string; speakerName?: string };
    if ((m?.kind === "choices" || m?.kind === "secret-request") && m.pending !== false) {
      const attention = {
        id: `at${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        botId: m.botId || "",
        botName: m.speakerName || "",
        kind: m.kind,
        title: String(m.content || m.question || "Needs your input").slice(0, 140),
        ts: Date.now(),
      };
      const ap = `event: attention\ndata: ${JSON.stringify(attention)}\n\n`;
      for (const res of clients) res.write(ap);
    }
  }
}

// Cloud steady refresh: local mode streams over SSE; cloud threads only change server-side,
// so tail them while a client is connected and push the same way. Cheap ticks poll thread
// tails (KV reads); every 8th tick refreshes the full snapshot for desk status changes.
const cloudTailSig = new Map();
let cloudTickBusy = false;
let cloudTickCount = 0;
setInterval(async () => {
  if (!clients.size || cloudTickBusy || account.useMockAuth()) return;
  cloudTickBusy = true;
  try {
    cloudTickCount += 1;
    if (cloudTickCount % 8 === 0) {
      const snap = await account.liveSnapshot();
      if (snap?.bots?.length || snap?.computers?.length) broadcast("cloud", snap);
    } else {
      const tails = await account.liveThreadTails();
      for (const t of tails || []) {
        if (t.messagesFailed || !Array.isArray(t.messages)) continue;
        // `ThreadTail.messages` is `unknown[]` on purpose — account.mts carries
        // Worker rows without reading one. This line reads two fields off the
        // last row to build a change signature, and says so.
        const last = t.messages.at(-1) as { id?: unknown; ts?: unknown } | undefined;
        const sig = `${t.messages.length}:${last?.id || ""}:${last?.ts || ""}`;
        if (cloudTailSig.get(t.botId) === sig) continue;
        cloudTailSig.set(t.botId, sig);
        broadcast("cloud-thread", t);
      }
    }
  } catch {
    /* signed out or offline — try again next tick */
  } finally {
    cloudTickBusy = false;
  }
}, 1000);

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

/** Audio ceiling for /api/dictate. A minute of the client's webm is ~1 MB. */
const DICTATE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * spawn + collect, without blocking the event loop.
 *
 * The two calls below were spawnSync, so a dictation held the ONLY thread for
 * up to 65s (20s ffmpeg + 45s whisper). Everything else stopped with it: the
 * /api/events SSE keepalive, every other route, the 15s routine tick, the 5s
 * wake drain and the 12s desktop sweep.
 */
function runOnce(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args);
    } catch (err) {
      return resolve({ status: null, stdout: "", stderr: String((err as Error)?.message || err) });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr || String(err?.message || err) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

app.post("/api/dictate", (req, res) => {
  // express.json() has already drained the stream for a JSON content-type, so
  // the "end" listener below would be attached to an ALREADY-ENDED readable and
  // never fire: no response at all, and the socket held until requestTimeout
  // (900s). The shipped client sends blob.type, so it never hits this; any other
  // local caller did.
  if (req.readableEnded) {
    return res.status(415).json({ ok: false, error: "send raw audio bytes, not JSON" });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let tooBig = false;
  req.on("data", (c) => {
    // express.json's 8mb limit only applies to what IT parses, so this stream
    // had no ceiling at all and accumulated the whole upload in memory.
    total += c.length;
    if (total > DICTATE_MAX_BYTES) {
      tooBig = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (tooBig) return;
    const buf = Buffer.concat(chunks);
    if (buf.length < 800) return res.status(400).json({ ok: false, error: "empty audio" });
    const raw = path.join("/tmp", `octo-dictate-${Date.now()}`);
    const src = `${raw}.bin`;
    const wav = `${raw}.wav`;
    try {
      await fs.writeFile(src, buf);
      const ff = await runOnce("ffmpeg", ["-y", "-i", src, "-ac", "1", "-ar", "16000", wav], 20_000);
      const use = existsSync(wav) ? wav : src;
      if (!existsSync(use) || ff.status !== 0 && !existsSync(wav)) {
        return res.status(422).json({ ok: false, error: ff.stderr?.slice(-200) || "couldn’t decode audio" });
      }
      const model = whisperModel();
      const cli = "/opt/homebrew/bin/whisper-cli";
      if (!model) {
        return res.status(500).json({ ok: false, error: "No Whisper model on this Mac." });
      }
      const r = await runOnce(cli, ["-m", model, "-f", use, "-nt", "-np", "-l", "en"], 45_000);
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
      // `as Error` here and at every other catch in this file: the only thing
      // read off a caught value is `.message`, and a route answers 500 with
      // whatever string that is. Nothing branches on the class.
      res.status(500).json({ ok: false, error: (e as Error).message });
    } finally {
      fs.unlink(src).catch(() => {});
      fs.unlink(wav).catch(() => {});
    }
  });
});

app.get("/api/health", async (_req, res) => {
  const docker = await vm.dockerStatus();
  // dataDir so a client can tell OUR server from another one holding the port:
  // the desktop app used to attach to whatever answered on 8787 and silently
  // adopt its data dir. Loopback-only route, the path is the caller's own
  // machine, and /api/account already returns the same field.
  res.json({ ok: true, docker, dataDir: path.resolve(store.dataDir) });
});

app.get("/api/docker", async (_req, res) => {
  const docker = await vm.dockerStatus();
  res.json({ ok: true, docker, install: vm.dockerInstallProgress() });
});

async function wakeDesksAfterDocker() {
  const rows = await computers.listComputers();
  const list = await vm.listLocalbotStates({ force: true });
  for (const row of rows) {
    const st = list.states.get(row.container);
    if (st && (st.status === "exited" || st.status === "created") && row.status !== "exited" && row.status !== "stopped") {
      await vm.startExistingContainer(row.container);
    }
  }
}

app.post("/api/docker/recover", async (req, res) => {
  req.setTimeout(180_000);
  res.setTimeout(180_000);
  try {
    const r = await vm.recoverDocker();
    if (r.ok) await wakeDesksAfterDocker();
    const docker = r.docker || (await vm.dockerStatus());
    const computersLive = docker.ok ? await liveComputers() : await computers.listComputers();
    broadcast("computers", { dirty: true });
    res.json({ ok: r.ok, action: r.action, killed: r.killed, log: r.log || "", docker, computers: computersLive });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/api/docker/install", async (req, res) => {
  req.setTimeout(720_000);
  res.setTimeout(720_000);
  try {
    const r = await vm.installDocker();
    if (r.ok) await wakeDesksAfterDocker();
    const docker = r.docker || (await vm.dockerStatus());
    const computersLive = docker.ok ? await liveComputers() : await computers.listComputers();
    broadcast("computers", { dirty: true });
    res.json({ ok: r.ok, action: r.action, log: r.log || "", docker, hint: r.hint || "", computers: computersLive });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message, hint: (err as Error).message });
  }
});

app.get("/api/ready", async (_req, res) => {
  try {
    const settings = await store.loadSettings();
    const h = settings.harness || {};
    const harnessOk =
      ((h.provider || "grok-build") === "grok-build" || h.provider === "spacexai" || h.provider === "custom") &&
      (h.model || "grok-4.6") === "grok-4.6";
    const bots = await store.loadBots() as IndexBot[];
    const bot = bots[0] || null;
    const stream = bot ? await vm.streamHealth(bot as vm.Bot) : { ok: false, error: "no bot" };
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
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

async function accountPayload() {
  if (!account.cloudFeaturesEnabled()) return account.disabledAccount();
  const bots = await store.loadBots() as IndexBot[];
  const row = await account.loadAccount({ hasLocalBots: bots.length > 0 });
  return account.publicAccount(row, {
    requireAccount: account.requireAccount(),
    hasLocalBots: bots.length > 0,
  });
}

/**
 * A Cloud failure as account.mts throws it: an Error carrying the Worker's own
 * `code` and the billing fields that go with it. Every field is a claim — the
 * throw site decides which ones it sets — so each read below is guarded.
 */
interface AccountError extends Error {
  code?: string | undefined;
  status?: unknown;
  billingUrl?: string | undefined;
  sku?: string | undefined;
  used?: number | undefined;
  entitled?: number | undefined;
  unitAmountCents?: number | undefined;
}

/** The JSON `sendAccountError` answers with. Only `error` and `code` are always sent. */
interface AccountErrorBody {
  error: string;
  code: string;
  billingUrl?: string | undefined;
  sku?: string | undefined;
  used?: number | undefined;
  entitled?: number | undefined;
  unitAmountCents?: number | undefined;
}

// `err` arrives as the `unknown` of a catch clause at all 25 call sites; the
// assertions below are what say this route reads a thrown AccountError, and
// they are cheaper than repeating one at every one of those call sites.
function sendAccountError(res: Response, err: unknown): void {
  const code = (err as AccountError).code || "ERROR";
  const status =
    Number((err as AccountError).status) ||
    (code === "SIGN_IN"
      ? 401
      : code === "NEED_BILLING"
        ? 402
        : code === "NEED_BRAIN" || code === "NEED_DESK"
        ? 409
        : code === "BAD_EMAIL" || code === "BAD_SESSION"
          ? 422
          : code === "ACCOUNT_REQUIRED"
            ? 403
            : 400);
  const body: AccountErrorBody = { error: (err as AccountError).message || "account error", code };
  if ((err as AccountError).billingUrl) body.billingUrl = (err as AccountError).billingUrl;
  if ((err as AccountError).sku) body.sku = (err as AccountError).sku;
  if ((err as AccountError).used != null) body.used = (err as AccountError).used;
  if ((err as AccountError).entitled != null) body.entitled = (err as AccountError).entitled;
  if ((err as AccountError).unitAmountCents != null) body.unitAmountCents = (err as AccountError).unitAmountCents;
  res.status(status).json(body);
}

app.get("/api/settings", async (_req, res) => {
  const s = await store.loadSettings();
  const safe = { ...s, harness: { ...s.harness, apiKey: s.harness.apiKey ? "••••" : "" } };
  res.json({
    settings: safe,
    hasEnvKey: Boolean(process.env.XAI_API_KEY),
    hasGrokAuth: await vm.hostHasGrokAuth(),
    // @sub8/store spells "no override" as `null`; `ContextSettings` spells it as
    // an absent key. `resolveZone` ORs the field with the environment, so both
    // reach the same branch. Same assertion as mcp-sub8 makes on the same call.
    timezone: resolveZone(s as ContextSettings),
    docker: await vm.dockerStatus(),
    appVersion: appUpdate.appVersion(),
    harnessProviders: HARNESS_PROVIDERS,
    account: await accountPayload(),
  });
});

app.get("/api/account", async (_req, res) => {
  try {
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

function accountOff(res: Response): boolean {
  if (account.cloudFeaturesEnabled()) return false;
  res.status(404).json({ error: "Accounts are off. Unset SUB8_ACCOUNT=0 to enable sign-in.", code: "ACCOUNT_OFF" });
  return true;
}

function cloudProductOff(res: Response): boolean {
  if (account.cloudProductEnabled()) return false;
  res.status(404).json({ error: "Cloud desks are coming soon.", code: "CLOUD_SOON" });
  return true;
}

app.post("/api/account/local", async (_req, res) => {
  if (accountOff(res)) return;
  try {
    await account.chooseLocal();
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/magic", async (req, res) => {
  if (accountOff(res)) return;
  try {
    const started = await account.startMagic(req.body?.email);
    const pub = await accountPayload();
    res.json({ ...pub, mock: started.mock, sent: !started.mock });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/complete", async (req, res) => {
  if (accountOff(res)) return;
  try {
    await account.completeSession(req.body || {});
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/x/start", async (_req, res) => {
  if (accountOff(res)) return;
  try {
    const started = await account.startX();
    const pub = await accountPayload();
    res.json({ ...pub, ...started });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/account/x/wait", async (req, res) => {
  if (accountOff(res)) return;
  try {
    const waited = await account.waitX(req.query?.state);
    const pub = await accountPayload();
    res.json({ ...pub, signedIn: Boolean(waited.signedIn || pub.signedIn) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/logout", async (_req, res) => {
  if (accountOff(res)) return;
  try {
    await account.logout();
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/cloud-prompt", async (req, res) => {
  if (accountOff(res)) return;
  try {
    if (req.body?.never || req.body?.dismiss) await account.dismissCloudPrompt();
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/account/view", async (req, res) => {
  if (accountOff(res)) return;
  try {
    await account.setView(req.body?.view);
    res.json(await accountPayload());
  } catch (err) {
    sendAccountError(res, err);
  }
});

async function requireCloudSession(_req: Request, res: Response) {
  if (cloudProductOff(res)) return null;
  const pub = await accountPayload();
  if (!pub.signedIn) {
    res.status(401).json({ error: "Sign in to use Cloud.", code: "SIGN_IN" });
    return null;
  }
  return pub;
}

app.get("/api/cloud/draft", async (_req, res) => {
  try {
    if (!(await requireCloudSession(_req, res))) return;
    if (!account.useMockAuth()) {
      res.json(await account.liveSnapshot());
      return;
    }
    res.json(await cloudDraft.snapshot());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/stream-health", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const computerId = String(req.query.computerId || "").trim();
    const display = req.query.display || "1";
    res.json(await account.probeCloudStream({ computerId, display }));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/draft/computers", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      const snap = await account.liveCreateDesk(req.body?.sku || "vm.4g");
      const created = snap.computer || null;
      // `created` IS `snap.computer`, read one line up, so the spread rewriting
      // the key it was read from changes nothing. The assertion is what says so.
      res.json({ computer: created, ...(snap as Omit<typeof snap, "computer">) });
      return;
    }
    const row = await cloudDraft.createComputer({ name: req.body?.name, size: req.body?.size });
    res.json({ computer: row, ...(await cloudDraft.snapshot()) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.patch("/api/cloud/draft/computers/:id", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const row = await cloudDraft.patchComputer(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: "not found" });
    res.json({ computer: row, ...(await cloudDraft.snapshot()) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.delete("/api/cloud/draft/computers/:id", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      res.json(await account.liveDestroyDesk(req.params.id));
      return;
    }
    const ok = await cloudDraft.destroyComputer(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json(await cloudDraft.snapshot());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/draft/bots", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      const snap = await account.liveCreateMate({
        computerId: req.body?.computerId,
        name: req.body?.name,
        job: req.body?.job || req.body?.description,
      });
      // Same key, same object: `snap.bot` spread back over itself.
      res.json({ bot: snap.bot, ...(snap as Omit<typeof snap, "bot">) });
      return;
    }
    const bot = await cloudDraft.createBot(req.body || {});
    res.json({ bot, ...(await cloudDraft.snapshot()) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.patch("/api/cloud/draft/bots/:id", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      const photo = typeof req.body?.avatar?.photo === "string" ? req.body.avatar.photo : typeof req.body?.photo === "string" ? req.body.photo : undefined;
      const snap = await account.livePatchMate({
        computerId: req.body?.computerId,
        botId: req.params.id,
        name: req.body?.name,
        job: req.body?.job || req.body?.description || req.body?.instructions,
        identityId: typeof req.body?.identityId === "string" ? req.body.identityId : undefined,
        photo,
      });
      // Same key, same object: `snap.bot` spread back over itself.
      res.json({ bot: snap.bot, ...(snap as Omit<typeof snap, "bot">) });
      return;
    }
    // `DraftBotPatch` spells `harness` and `avatar` as the draft store writes
    // them; a request body is the same JSON with every field still a claim.
    const bot = await cloudDraft.patchBot(req.params.id, req.body as cloudDraft.DraftBotPatch || {});
    if (!bot) return res.status(404).json({ error: "not found" });
    res.json({ bot, ...(await cloudDraft.snapshot()) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.delete("/api/cloud/draft/bots/:id", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      res.json(
        await account.liveDeleteMate({
          computerId: req.body?.computerId || req.query?.computerId,
          botId: req.params.id,
        }),
      );
      return;
    }
    const ok = await cloudDraft.deleteBot(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json(await cloudDraft.snapshot());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/draft/bots/:id/messages", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    if (!account.useMockAuth()) {
      const { computerId, botId } = account.cloudMessageIdentity(req.body || {}, req.params.id);
      const text = String(req.body?.content || "").trim();
      if (!text) return res.status(422).json({ error: "empty", code: "EMPTY" });
      const turned = await account.liveBrainChat({
        computerId,
        content: text,
        botId,
        identityId: typeof req.body?.identityId === "string" ? req.body.identityId : undefined,
      });
      const snap = await account.liveSnapshot();
      // `liveBrainChat` answers `unknown` — account.mts moves the Worker's turn
      // payload without reading one. `CloudTurnReply` is the three fields this
      // route forwards to the client, and this is where that is stated.
      const userMessage = (turned as CloudTurnReply)?.userMessage || (turned as CloudTurnReply)?.reply?.userMessage;
      res.json({ ...snap, ok: true, queued: true, turnId: (turned as CloudTurnReply)?.turnId, userMessage, reply: turned });
      return;
    }
    // `addMessage` spells `content` `string`; an empty body reaches it as
    // undefined and comes back as a draft with an empty row, exactly as it did
    // before this file had types.
    const bot = await cloudDraft.addMessage(req.params.id, req.body?.content as string);
    if (!bot) return res.status(404).json({ error: "not found" });
    res.json({ bot, ...(await cloudDraft.snapshot()) });
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/brain", async (_req, res) => {
  try {
    if (!(await requireCloudSession(_req, res))) return;
    res.json(await account.liveBrain());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/billing/summary", async (_req, res) => {
  try {
    if (!(await requireCloudSession(_req, res))) return;
    res.json(await account.liveBillingSummary());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/billing/portal", async (_req, res) => {
  try {
    if (!(await requireCloudSession(_req, res))) return;
    res.json(await account.liveBillingPortal());
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/billing/checkout", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBillingCheckout(req.body?.items));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/grok/start", async (_req, res) => {
  try {
    if (!(await requireCloudSession(_req, res))) return;
    res.json(await account.liveBrainStartGrok());
  } catch (err) {
    sendAccountError(res, err);
  }
});

// Claude desk login, proxied for the desktop app. iOS has had these four since
// the flow was built; the desktop had none, so a desk on the default provider
// ("claude") could not be signed in from the Mac at all.
app.get("/api/cloud/brain/claude/auth", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainClaudeAuth(String(req.query.computerId || "")));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/claude/auth/start", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainClaudeAuthStart(String(req.body?.computerId || "")));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/claude/auth/code", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(
      await account.liveBrainClaudeAuthCode(String(req.body?.computerId || ""), String(req.body?.code || "")),
    );
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/claude/auth/logout", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainClaudeAuthLogout(String(req.body?.computerId || "")));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/brain/grok/wait", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainWaitGrok(req.query.id));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/key", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainKey(req.body || {}));
  } catch (err) {
    sendAccountError(res, err);
  }
});

// Cloud routines are stored per desk in Worker KV, so these are scoped by
// computerId, not by bot id the way /api/bots/:id/routines is. A local bot owns
// its own routines; every bot on a Cloud desk shares one list.
// The plugins a Cloud desk's harness exposes and whether each is connected,
// read live from that desk. Same shape as GET /api/harness/:provider/plugins.
app.get("/api/cloud/brain/plugins", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const provider = typeof req.query.provider === "string" && req.query.provider ? req.query.provider : "claude";
    res.json(await account.liveBrainPlugins(String(req.query.computerId || ""), provider, String(req.query.refresh || "") === "1"));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/brain/routines", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainRoutines({ computerId: req.query.computerId }));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/routines", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const body = req.body || {};
    res.json(
      await account.liveBrainRoutineCreate({
        computerId: body.computerId,
        name: body.name,
        instruction: body.instruction,
        intervalMinutes: body.intervalMinutes,
        botId: body.botId,
      }),
    );
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.patch("/api/cloud/brain/routines", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const body = req.body || {};
    res.json(
      await account.liveBrainRoutinePatch({
        computerId: body.computerId,
        id: body.id,
        name: body.name,
        instruction: body.instruction,
        intervalMinutes: body.intervalMinutes,
        enabled: body.enabled,
        botId: body.botId,
      }),
    );
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.delete("/api/cloud/brain/routines", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const body = req.body || {};
    res.json(await account.liveBrainRoutineDelete({ computerId: body.computerId, id: body.id }));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.get("/api/cloud/brain/turn", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainTurn({ computerId: req.query.computerId, id: req.query.id }));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/abort", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    res.json(await account.liveBrainAbort({ computerId: req.body?.computerId, turnId: req.body?.turnId, all: Boolean(req.body?.all) }));
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/desk-action", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const raw = req.body?.action;
    const action =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : { action: req.body?.action, text: req.body?.text };
    res.json(
      await account.liveDeskAction({
        computerId: req.body?.computerId,
        action,
      }),
    );
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/cloud/brain/control", async (req, res) => {
  try {
    if (!(await requireCloudSession(req, res))) return;
    const on = Boolean(req.body?.on);
    const computerId = req.body?.computerId;
    const out = await account.liveBrainControl({ computerId, on });
    const botId = String(req.body?.botId || "").trim() || account.cloudBotId(computerId);
    const display = req.body?.display;
    // `cloudDeskBotIds` only ever `for…of`s its third argument; a Map key
    // iterator walks the same way an array does.
    const deskIds = account.cloudDeskBotIds(computerId, botId, turnAbort.keys() as unknown as readonly unknown[]);
    for (const id of deskIds) {
      await holdHumanControl(id, on);
      if (on) stopTurn(id);
    }
    res.json(out);
    if (!on && computerId && !account.useMockAuth()) {
      account
        .liveBrainChat({
          computerId,
          botId,
          display,
          persistUser: false,
          content:
            "The user released the computer. Screenshot and continue what you were doing. If you were idle, just confirm you have the desktop again.",
        })
        .catch(() => {});
    }
  } catch (err) {
    sendAccountError(res, err);
  }
});

app.post("/api/internal/emit", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const botId = req.body?.botId;
  const event = req.body?.event || "message";
  const data = req.body?.data || {};
  if (!botId) return res.status(400).json({ error: "botId required" });
  if (event === "message" && data?.role) {
    await store.patchBot(botId, (b) => {
      applyInternalEmit(b as ChoiceBot, data);
    });
  }
  broadcast(event, { botId, ...data });
  import("./hermes-acp.mjs")
    .then((h) => h.touchHermesAcp())
    .catch(() => {});
  res.json({ ok: true });
});

/** nothing_to_add: end the turn now, quietly — no wait-for-a-pick state. */
app.post("/api/internal/quiet-end", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const id = String(req.body?.botId || "");
  if (!id) return res.status(400).json({ error: "botId required" });
  stopTurn(id);
  res.json({ ok: true, ended: true });
});

app.post("/api/internal/end-turn", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const id = String(req.body?.botId || "");
  if (!id) return res.status(400).json({ error: "botId required" });
  stopTurn(id);
  await store.patchBot(id, (b) => {
    b.awaitingUserSelection = true;
  }).catch(() => {});
  res.json({ ok: true, ended: true });
});

let deskToolChain = Promise.resolve();
function withDeskToolLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = deskToolChain.then(fn, fn);
  deskToolChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

app.post("/api/internal/desk-tool", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const botId = String(req.body?.botId || "");
  const name = String(req.body?.name || "");
  const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};
  const bot = await store.getBot(botId) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  try {
    if (name === "list_teammates") {
      const all = await store.loadBots() as IndexBot[];
      const mates = all.filter(
        (b) => b.id === bot.id || (bot.teamId && b.teamId === bot.teamId) || (bot.vm?.computerId && b.vm?.computerId === bot.vm.computerId),
      );
      return res.json({
        ok: true,
        output: JSON.stringify(mates.map((b) => ({ id: b.id, name: b.name, role: b.teamRole || "", job: b.description || "" }))),
      });
    }
    if (name === "create_teammate") {
      return await withDeskToolLock(async () => {
        const live = ((await store.getBot(botId)) as IndexBot | null) || bot;
        const job = String(args.job || "").trim();
        const nm = String(args.name || "").trim() || "Worker";
        if (!job) return res.status(400).json({ error: "job required" });
        const team = await teams.ensureTeamForBot(live as IndexBot);
        const { bot: mate } = await teams.addMember(team, {
          name: nm,
          job,
          role: args.role === "chief" ? "chief" : "worker",
          harness: {
            ...(live.harness || {}),
            ...(args.harness || args.provider ? { provider: String(args.harness || args.provider) } : {}),
            ...(args.model
              ? { model: String(args.model) }
              : String(args.harness || args.provider) === "cursor"
                ? { model: "cursor-grok-4.6-low" }
                : {}),
          },
        });
        broadcast("teammate", { bot: { id: mate.id, name: mate.name, teamId: mate.teamId, teamRole: mate.teamRole, color: mate.color, harness: mate.harness, vm: mate.vm } });
        return res.json({ ok: true, output: `created ${mate.name} (${mate.id})` });
      });
    }
    if (name === "message_teammate") {
      const toId = String(args.bot_id || args.id || "");
      const content = String(args.message || args.content || "").trim();
      if (!toId || !content) return res.status(400).json({ error: "bot_id and message required" });
      const incoming = {
        id: `u${Date.now()}tm`,
        role: "user",
        speakerId: bot.id,
        speakerName: bot.name || "a teammate",
        speakerRole: bot.teamRole || "chief",
        content: teammate.storedChiefToWorker(bot.name || "Chief", content),
        ts: Date.now(),
      };
      const liveBot = await store.patchBot(toId, (b) => {
        b.messages = b.messages || [];
        b.messages.push(incoming);
      });
      if (!liveBot) return res.status(404).json({ error: "teammate not found" });
      broadcast("message", { botId: toId, ...incoming });
      enqueueTurn(toId, () =>
        runUserTurn(
          toId,
          teammate.wrapWorkerDispatch({
            who: bot.name,
            role: bot.teamRole || "chief",
            text: content,
          }),
          false,
          [],
          {
            persistUser: false,
            replyTo: bot.id,
          },
        ),
      );
      return res.json({ ok: true, output: `sent to ${toId}` });
    }
    if (name === "task") {
      const row = await subagents.spawn({
        botId: bot.id,
        type: args.type || "executor",
        prompt: args.prompt,
        display: bot.vm?.display,
        computerId: bot.vm?.computerId,
        container: bot.vm?.container,
        harnessUrl: `http://127.0.0.1:${bot.vm?.harnessPort || ""}`,
        harnessToken: internalToken,
      });
      return res.json({ ok: true, output: JSON.stringify(row) });
    }
    return res.status(400).json({ error: `unknown tool ${name}` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || String(err) });
  }
});

app.post("/api/internal/show-user", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  const botId = String(req.body?.botId || "");
  const image = String(req.body?.image || "");
  const caption = String(req.body?.content || "").trim();
  if (!botId || !image) return res.status(400).json({ error: "botId and image required" });
  const bot = await store.getBot(botId) as IndexBot | null;
  if (!bot?.teamId) return res.json({ ok: true, channel: false });
  const posted = await teams.appendMessage(bot.teamId, {
    role: "assistant",
    speakerId: bot.id,
    speakerName: bot.name,
    speakerRole: bot.teamRole || "worker",
    content: caption,
    image,
  } as Partial<store.Message>);
  broadcast("team-message", { teamId: bot.teamId, ...posted });
  res.json({ ok: true, channel: true });
});

app.post("/api/internal/team-dispatch", async (req, res) => {
  if (req.get("x-sub8-token") !== internalToken) return res.status(401).json({ error: "unauthorized" });
  if (req.body?.stopId) {
    stopTurn(String(req.body.stopId));
    deletedIds.add(String(req.body.stopId));
    return res.json({ ok: true, stopped: true });
  }
  const fromId = String(req.body?.fromId || "");
  const content = String(req.body?.content || "").trim();
  // Full message_teammate on behalf of the subprocess (resolve, channel line,
  // sender note, dispatch, job tracking) when it sends `to`; the older
  // {fromId,toId,content} shape still just dispatches.
  const to = String(req.body?.to || "");
  if (to) {
    if (!fromId || !content) return res.status(400).json({ error: "fromId, to and content required" });
    const str = (v: unknown) => (v == null ? undefined : String(v));
    const r = await teammateMessage({ fromId, to, content, label: str(req.body?.label), status: str(req.body?.status), detail: str(req.body?.detail), stepId: str(req.body?.stepId) });
    return res.json(r);
  }
  const toId = String(req.body?.toId || "");
  if (!toId || !content) return res.status(400).json({ error: "toId and content required" });
  const from = fromId ? await store.getBot(fromId) as IndexBot | null : null;
  dispatchToTeammate(toId, content, from);
  res.json({ ok: true });
});

app.get("/api/update", async (req, res) => {
  const current = String(req.query.current || "").trim() || undefined;
  // `checkForAppUpdate` spells `current` `?: string`; `current` is already
  // `|| undefined` two lines up, which is the absent key it means.
  res.json(await appUpdate.checkForAppUpdate({ current } as { current?: string }));
});

/**
 * After any local vault change, keep the cloud copy in step: re-seal and push to
 * the Worker. Best-effort and non-blocking — a local edit never waits on the
 * network, and a sync failure never fails the edit.
 */
/** Make sure this computer holds the cloud escrow key (fetch it, or mint + upload one), so always-on can be offered. No-op offline. */
async function adoptCloudEscrow(): Promise<void> {
  const existing = await account.getCloudEscrowKey().catch(() => null);
  if (existing) {
    await vaultSync.setEscrowKey(existing);
    return;
  }
  const fresh = await vaultSync.freshEscrowKey();
  await account.putCloudEscrowKey(fresh).catch(() => {});
}

function syncVaultToCloud(): void {
  if (!vaultSync.isEnabled() || !vaultSync.isUnlocked()) return;
  void vaultSync
    .resync()
    .then((env) => (env ? account.putCloudVault(env).catch(() => {}) : undefined))
    .catch(() => {});
}

app.get("/api/vault/cloud", async (_req, res) => {
  try {
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Turn on the cloud vault: set the passphrase here (never sent to the Worker),
// seal the current vault, and push the ciphertext. If cloud is signed in, adopt
// the account escrow key so always-on can be offered.
app.post("/api/vault/cloud/enable", async (req, res) => {
  try {
    const passphrase = String(req.body?.passphrase || "");
    await adoptCloudEscrow().catch(() => {});
    const env = await vaultSync.enable(passphrase);
    await account.putCloudVault(env).catch(() => {});
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/vault/cloud/unlock", async (req, res) => {
  try {
    await adoptCloudEscrow().catch(() => {});
    // Pull a newer copy from the Worker before unlocking, so other devices' edits land.
    const remote = await account.getCloudVault().catch(() => null);
    if (remote) await vaultSync.applyPulled(remote as unknown as vaultSync.CloudVaultEnvelope).catch(() => {});
    await vaultSync.unlock(String(req.body?.passphrase || ""));
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/vault/cloud/lock", async (_req, res) => {
  vaultSync.lock();
  res.json(await vaultSync.status());
});

app.post("/api/vault/cloud/passphrase", async (req, res) => {
  try {
    const env = await vaultSync.changePassphrase(String(req.body?.passphrase || ""));
    await account.putCloudVault(env).catch(() => {});
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/vault/cloud/disable", async (_req, res) => {
  try {
    await vaultSync.disable();
    await account.deleteCloudVault().catch(() => {});
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Mark a login always-on (unattended cloud autofill escrows its password).
app.put("/api/vault/cloud/always-on/:id", async (req, res) => {
  try {
    const env = await vaultSync.setAlwaysOn(req.params.id, req.body?.on !== false);
    await account.putCloudVault(env).catch(() => {});
    res.json(await vaultSync.status());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/vault", async (_req, res) => {
  try {
    res.json(await vault.snapshot());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/vault/groups", async (req, res) => {
  const group = await vault.upsertGroup({ id: req.body?.id, name: req.body?.name });
  res.json(group);
  syncVaultToCloud();
});

app.delete("/api/vault/groups/:id", async (req, res) => {
  res.json(await vault.deleteGroup(req.params.id));
  syncVaultToCloud();
});

app.post("/api/vault/accounts", async (req, res) => {
  const acc = await vault.upsertAccount(req.body || {});
  res.json(acc);
  syncVaultToCloud();
});

app.patch("/api/vault/accounts/:id", async (req, res) => {
  const acc = await vault.upsertAccount({ ...(req.body || {}), id: req.params.id });
  res.json(acc);
  syncVaultToCloud();
});

app.delete("/api/vault/accounts/:id", async (req, res) => {
  res.json(await vault.deleteAccount(req.params.id));
  syncVaultToCloud();
});

app.get("/api/vault/accounts/:id/reveal", async (req, res) => {
  const acc = await vault.revealAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  res.json(acc);
});

app.get("/api/vault/export", async (_req, res) => {
  try {
    const backup = await vault.exportVault();
    res.setHeader("Content-Disposition", 'attachment; filename="sub8-vault.json"');
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/vault/import", async (req, res) => {
  try {
    const mode = req.body?.mode === "merge" ? "merge" : "replace";
    const snap = await vault.importVault(req.body, mode);
    const bots = (await store.loadBots()) as IndexBot[];
    for (const bot of bots) vault.pushListToBot(bot as vault.VaultBot).catch(() => {});
    res.json(snap);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
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
    const out: { id: string; ok: boolean; error: string | null }[] = [];
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
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/computers", async (_req, res) => {
  try {
    const docker = await vm.dockerStatus();
    const rows = docker.ok || !docker.stuck ? await liveComputers() : await staleComputers(docker);
    res.json({ computers: rows, docker });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/computers/stats", async (_req, res) => {
  try {
    const rows = await computers.listComputers();
    const stats = await vm.containerStats(rows.map((c) => c.container));
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/computers/:id", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(await computers.saveComputer({ ...row, name }));
});

async function computerBot(row: computers.Computer) {
  const bots = await store.loadBots() as IndexBot[];
  return bots.find((b) => b.vm?.computerId === row.id) || null;
}

// Image routes must register before POST /:id/:action so Express does not treat
// "images" as an action name.
app.get("/api/computers/:id/images/progress", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ progress: deskImages.getDiskJob(row.id) });
});

app.get("/api/computers/:id/images", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const images = deskImages.readCatalog(dataDir).filter((img) => img.computerId === row.id);
  res.json({ images });
});

app.post("/api/computers/:id/images", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const dock = await vm.dockerStatus();
  if (!dock.ok) return res.status(503).json({ error: "Docker is not running." });
  try {
    const image = await deskImages.performSnapshot({
      computerId: row.id,
      note: typeof req.body?.note === "string" ? req.body.note : "",
      dataDir,
      run: deskImages.dockerRunner(),
      computer: { id: row.id, container: row.container, volume: row.volume },
    });
    broadcast("computers", { dirty: true });
    res.json({ image });
  } catch (err) {
    const status = Number((err as { status?: number })?.status) || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.post("/api/computers/:id/images/:imageId/restore", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const dock = await vm.dockerStatus();
  if (!dock.ok) return res.status(503).json({ error: "Docker is not running." });
  try {
    const image = await deskImages.performRestore({
      computerId: row.id,
      imageId: req.params.imageId,
      dataDir,
      run: deskImages.dockerRunner(),
      computer: { id: row.id, container: row.container, volume: row.volume },
    });
    await computers.saveComputer({ ...row, status: "running", pausedByQuit: false });
    broadcast("computers", { dirty: true });
    res.json({ image });
  } catch (err) {
    const status = Number((err as { status?: number })?.status) || 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.delete("/api/computers/:id/images/:imageId", async (req, res) => {
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const existing = deskImages.readCatalog(dataDir).find((img) => img.id === req.params.imageId && img.computerId === row.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  deskImages.beginDiskJob({ computerId: row.id, action: "delete", phase: "deleting", bytes: 0, totalBytes: existing.bytes || null });
  try {
    const removed = deskImages.removeImageRow(dataDir, existing.id);
    res.json({ ok: true, image: removed });
  } finally {
    deskImages.endDiskJob(row.id);
  }
});

async function waitCloudDeskReady(id: string, timeoutMs = 180_000): Promise<{ id: string; ipv4: string; status: string }> {
  const start = Date.now();
  let lastStatus = "";
  while (Date.now() - start < timeoutMs) {
    const snap = await account.liveSnapshot();
    const hit = (snap.computers || []).find((c) => c.id === id);
    lastStatus = String(hit?.status || lastStatus);
    const ipv4 = String(hit?.ipv4 || "");
    const status = String(hit?.status || "");
    const deskId = String(hit?.id || "");
    if (deskId && ipv4 && (status === "assigned" || status === "warm")) return { id: deskId, ipv4, status };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(lastStatus ? `Cloud desk stayed ${lastStatus}.` : "Cloud desk did not become ready in time.");
}

app.post("/api/computers/:id/move-to-cloud", async (req, res) => {
  if (!(await requireCloudSession(req, res))) return;
  const row = await computers.getComputer(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  const dock = await vm.dockerStatus();
  if (!dock.ok) return res.status(503).json({ error: "Docker is not running." });
  const botId = String(req.body?.botId || row.attachedBotId || row.lastBotId || "");
  const bot = botId ? await store.getBot(botId) : null;
  const name = String(req.body?.name || (bot && (bot as { name?: string }).name) || row.name || "Bot").trim() || "Bot";
  req.setTimeout(5 * 60_000);
  res.setTimeout(5 * 60_000);
  try {
    const image = await deskImages.performSnapshot({
      computerId: row.id,
      note: `move-to-cloud ${name}`,
      dataDir,
      run: deskImages.dockerRunner(),
      computer: { id: row.id, container: row.container, volume: row.volume },
    });
    deskImages.beginDiskJob({ computerId: row.id, action: "snapshot", phase: "creating", bytes: 0, totalBytes: image.bytes || null });
    const created = await account.liveCreateDesk("vm.4g");
    const deskId = String((created.computer && created.computer.id) || "");
    if (!deskId) throw new Error("Cloud did not return a computer.");
    deskImages.patchDiskJob(row.id, { phase: "waiting" });
    const ready = await waitCloudDeskReady(deskId);
    const chiefId = account.cloudBotId(ready.id);
    deskImages.patchDiskJob(row.id, { phase: "naming" });
    const job = String((bot as { description?: string; instructions?: string } | null)?.description || (bot as { instructions?: string } | null)?.instructions || "").trim();
    await account.livePatchMate({
      computerId: ready.id,
      botId: chiefId,
      name,
      ...(job ? { job } : {}),
    });
    deskImages.patchDiskJob(row.id, { phase: "copying" });
    const archiveAbs = path.join(deskImages.imagesDir(dataDir), image.fileName);
    const runDesk = async (cmd: string) => {
      const out = (await account.liveDeskAction({
        computerId: ready.id,
        action: { action: "shell", text: cmd },
      })) as { ok?: boolean; text?: string };
      return out || {};
    };
    const copied = await copyArchiveToDesk(archiveAbs, runDesk, { fromBotId: bot?.id, toBotId: chiefId });
    await runDesk(stampAgentsMdShell(identityStamp({ handle: name, personalName: copied.personalName })));
    if (bot?.id) {
      const conv = await store.loadConversation(bot.id);
      if (conv.length) {
        await account.liveSaveThread({ computerId: ready.id, botId: chiefId, messages: conv });
      }
    }
    deskImages.endDiskJob(row.id);
    res.json({ ok: true, computerId: ready.id, botId: chiefId, name, files: copied.count, imageId: image.id });
  } catch (err) {
    deskImages.endDiskJob(row.id);
    sendAccountError(res, err);
  }
});

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
      if (bot) await patchVm(bot.id, { status: "paused" });
    } else if (action === "resume") {
      const st = await vm.inspectState(row.container);
      if (!st.exists) {
        if (!bot) return res.status(400).json({ error: "Attach this computer to a Bot, then Start." });
        const info = await vm.startVm(bot as vm.Bot, (m) => broadcast("log", { botId: bot.id, m }));
        bot.vm = { ...bot.vm, ...info, computerId: row.id, error: null };
        await store.upsertBot(bot);
        await computers.saveComputer({ ...row, status: "running", pausedByQuit: false, novncPort: info.novncPort });
        broadcast("bot", toClient(bot));
      } else {
        const r = await vm.resumeContainer(row.container);
        if (!r.ok) return res.status(400).json(r);
        await computers.saveComputer({ ...row, status: "running", pausedByQuit: false });
        if (bot) await patchVm(bot.id, { status: "running" });
      }
    } else if (action === "reboot") {
      const r = await vm.rebootContainer(row.container);
      if (!r.ok) return res.status(400).json(r);
      await computers.saveComputer({ ...row, status: "running", pausedByQuit: false, novncPort: r.novncPort || row.novncPort });
      if (bot) {
        await patchVm(bot.id, { status: "running", novncPort: r.novncPort || bot.vm?.novncPort, error: null, hint: "" });
      }
    } else if (action === "start") {
      const owner = bot || (req.body?.botId ? await store.getBot(req.body.botId) as IndexBot | null : null);
      if (!owner) return res.status(400).json({ error: "Attach this computer to a Bot first." });
      // The same refusal `attach` makes below. Without it, starting computer A
      // with a botId that already belongs to computer B re-pointed that bot's
      // vm.container/volume/computerId at A -- and B was never touched, so its
      // container kept running with nothing referring to it and the bot's whole
      // working state in volume B became unreachable from the app. It sticks,
      // too: upsertBot only restores prev.vm when prev is newer, and `owner` was
      // just read from that row, so the timestamps are equal.
      //
      // Teammates deliberately share one desk, so only a DIFFERENT computer is
      // refused, exactly as attach does.
      if (owner.vm?.computerId && owner.vm.computerId !== row.id) {
        return res.status(409).json({ error: "That Bot already has a computer. Detach it first." });
      }
      owner.vm = { ...owner.vm, computerId: row.id, container: row.container, volume: row.volume };
      const info = await vm.startVm(owner as vm.Bot, (m) => broadcast("log", { botId: owner.id, m }));
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
      if (bot) await patchVm(bot.id, { status: "exited" });
    } else if (action === "destroy") {
      // `stopVm` reads `bot.id` only as the fallback for a missing container;
      // this stand-in carries the container, so the id is never reached.
      await vm.stopVm({ vm: { container: row.container, volume: row.volume } } as vm.Bot, { wipe: true });
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
      // `getBot` spells its id `string`; an attach with no botId reaches it as
      // undefined and comes back null, which is the "Pick a Bot." answer below.
      const nextBot = await store.getBot(req.body?.botId as string) as IndexBot | null;
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
    res.status(500).json({ error: (err as Error).message });
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
      new Promise<{ ok: boolean; error?: string }>((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 4000)),
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
  const bot = await store.getBot(req.params.botId) as IndexBot | null;
  if (bot) vault.pushListToBot(bot as vault.VaultBot).catch(() => {});
  res.json({ botId: req.params.botId, accountIds: ids });
});

app.put("/api/vault/accounts/:id/grants", async (req, res) => {
  const snap = await vault.setAccountGrants(req.params.id, req.body?.botIds || []);
  if (!snap) return res.status(404).json({ error: "not found" });
  const bots = await store.loadBots() as IndexBot[];
  for (const bot of bots) vault.pushListToBot(bot as vault.VaultBot).catch(() => {});
  res.json(snap);
});

app.put("/api/settings", async (req, res) => {
  const prev = await store.loadSettings();
  const next = { ...prev, ...req.body };
  if (req.body.harness) {
    next.harness = { ...prev.harness, ...req.body.harness };
    if (req.body.harness.apiKey === "••••") next.harness.apiKey = prev.harness.apiKey;
  }
  if (hostCli.shouldRotateHarnessSession(prev.harness?.provider, next.harness?.provider)) {
    const bots = (await store.loadBots()) as IndexBot[];
    for (const b of bots) {
      const local = b.harness?.provider;
      if (local && local !== "default") continue;
      b.harnessSessionId = randomUUID();
      b.grokSessionId = b.harnessSessionId;
      b.harnessSessionFresh = true;
      await store.upsertBot(b);
    }
  }
  // `next` is the stored record with a request body spread over it, so every
  // key it did not carry keeps the type `loadSettings` gave it and the ones it
  // did are still claims. `saveSettings` normalises the record it is handed —
  // that is the function that turns those claims back into settings.
  const saved = await store.saveSettings(next as Partial<store.Settings>);
  applyDeskMemorySetting(saved as { deskMemory?: unknown });
  // Mask the key on the way out, exactly as GET /api/settings does. This route
  // was handing the plaintext provider key back to the client on every settings
  // write — including the writes that only toggle a sidebar section. No caller
  // reads it: every client PUTs and then calls refreshSettings(), which is the
  // masking GET. Masking here makes the two routes agree.
  res.json({ ...saved, harness: { ...saved.harness, apiKey: saved.harness?.apiKey ? "••••" : "" } });
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
  const bot = botId ? await store.getBot(botId) as IndexBot | null : (await store.loadBots() as IndexBot[])[0];
  const box = bot?.vm?.container;
  if (!box) return res.json({ ok: false, started: false, signedIn: false });
  const job = vm.grokOAuthStatus(box);
  const signed = await vm.grokSignedIn(box);
  // grokOAuthStatus carries its own `ok` and the spread comes after, so the
  // literal `ok: true` this used to open with was dead — the response has always
  // answered the OAuth job's ok. It was also typed `as Omit<typeof job, "ok">`,
  // which erases: the declared shape claimed ok:true while the runtime spread
  // job.ok over it. Dropping both leaves the same response with an honest type.
  res.json({ ...job, signedIn: signed.ok, container: box });
});

/**
 * The plugins a harness exposes and whether each is connected, from this Mac's
 * cached listing (?refresh=1 forces a fresh one). A harness with no plugin
 * surface answers `supported:false` rather than 404 so the UI shows nothing.
 */
app.get("/api/harness/:provider/plugins", async (req, res) => {
  const provider = String(req.params.provider || "").trim();
  try {
    res.json(await hostCli.hostPlugins(provider, { force: String(req.query.refresh || "") === "1" }));
  } catch (e) {
    res.status(500).json({ ok: false, provider, supported: true, error: String((e as Error)?.message || e) });
  }
});

app.get("/api/identities", async (req, res) => {
  try {
    const settings = await store.loadSettings();
    const status = await collectHarnessStatus(settings);
    let rows = await identities.ensureHostIdentities(status);
    let cloudCtx: identities.CloudIdentityInput = {};
    if (account.cloudFeaturesEnabled()) {
      try {
        const acct = await account.loadAccount();
        if (account.sessionLive(acct.session)) {
          const computerId = String(req.query?.computerId || "").trim();
          const brain = await account.liveBrain().catch(() => null);
          let claude: { loggedIn?: unknown; email?: unknown } | null = null;
          if (computerId) {
            const raw = (await account.liveBrainClaudeAuth(computerId).catch(() => null)) as
              | { loggedIn?: unknown; email?: unknown; raw?: { loggedIn?: unknown; email?: unknown } }
              | null;
            claude = (raw?.raw || raw) as { loggedIn?: unknown; email?: unknown } | null;
          }
          cloudCtx = { brain, computerId, claude };
          rows = await identities.ensureCloudIdentities(cloudCtx);
        }
      } catch {
        /* cloud brain optional */
      }
    }
    res.json({
      identities: rows.map((row) =>
        row.place === "cloud" ? identities.decorateCloudIdentity(row, cloudCtx) : identities.decorateIdentity(row, status),
      ),
      catalog: (await import("@sub8/identities")).catalog(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/identities", async (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();
    const runtimeRef = req.body?.runtimeRef ? String(req.body.runtimeRef) : "";
    const row = await identities.addIdentity({
      provider: String(req.body?.provider || "").trim(),
      place: req.body?.place === "cloud" ? "cloud" : "local",
      ...(label ? { label } : {}),
      isolated: req.body?.isolated !== false,
      ...(runtimeRef ? { runtimeRef } : {}),
    });
    res.json({ identity: row });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch("/api/identities/:id", async (req, res) => {
  const patch: Partial<Identity> = {};
  if (typeof req.body?.label === "string") patch.label = req.body.label;
  if (typeof req.body?.subject === "string") patch.subject = req.body.subject;
  if (typeof req.body?.model === "string") patch.model = req.body.model;
  const row = await identities.patchIdentity(req.params.id, patch);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ identity: row });
});

app.delete("/api/identities/:id", async (req, res) => {
  // The cloud Claude identity is the account credential: removing it forgets
  // the credential on the Worker too, so it does not come straight back.
  if (req.params.id === "cloud-claude") {
    try {
      await account.liveBrainClaudeForget();
    } catch (err) {
      return sendAccountError(res, err);
    }
  }
  const ok = await identities.removeIdentity(req.params.id);
  if (!ok && req.params.id !== "cloud-claude") return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.get("/api/harness/local", async (_req, res) => {
  res.json(await detectLocalHarnesses({ force: true }));
});

app.get("/api/harness/status", async (req, res) => {
  try {
    const settings = await store.loadSettings();
    let snap = await collectHarnessStatus(settings);
    const sim = String(req.query?.simulate || process.env.SUB8_SIMULATE_HARNESS || "").trim();
    // `applySimulate` is generic over the browser's `HarnessStatus`, whose rows
    // spell `label` required where `StatusRow` leaves it optional. It only ever
    // reads and rewrites `harnesses[id]`, which both spellings carry.
    if (sim && process.env.SUB8_PACKAGED !== "1") snap = applySimulate(snap as HarnessStatus, sim) as typeof snap;
    res.json(snap);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.put("/api/harness/hermes", async (req, res) => {
  try {
    const model = String(req.body?.model || "").trim();
    if (!model) return res.status(400).json({ error: "model required" });
    const r = await hostCli.setHermesModel(model);
    // `setHermesModel` answers `ok: true` itself; the spread rewrites the same
    // value over the literal.
    res.json({ ok: true, ...(r as Omit<typeof r, "ok">) });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/api/harness/test", async (req, res) => {
  try {
    const settings = await store.loadSettings();
    const provider = String(req.body?.provider || "").trim() || undefined;
    // Same `userTimeZoneOverride` null-vs-absent as `resolveZone` above.
    const result = await pingHarness(
      settings as AgentSettings,
      req.body?.botId ? await store.getBot(req.body.botId) as AgentBotRow | null : null,
      provider,
    );
    res.json({
      ...result,
      log: result.log || result.sample || result.error || "",
      at: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message, log: (err as Error).message, at: Date.now() });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "empty query" });
    const settings = await store.loadSettings();
    const text = await webSearch(settings as AgentSettings, query);
    res.json({ ok: !text.startsWith("web_search failed"), query, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/bots", async (_req, res) => {
  res.json((await store.loadBots()).map((b) => toClient(b, { tail: 8 })));
});

async function publicTeams() {
  await teams.pruneSoloTeams();
  const [rows, bots] = await Promise.all([teams.listTeams(), store.loadBots() as Promise<IndexBot[]>]);
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
      desk = await computers.ensureComputerForBot(bot as computers.ComputerBot);
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
  vm.applyTeamDisplays(
    { chiefId: chief?.id, memberIds: created.map((b) => b.id) },
    created as vm.Bot[],
    desk?.novncPort || null,
  );
  for (const b of created) await store.upsertBot(b);
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

/**
 * Duplicate a team the way a solo bot is duplicated: the same members (name,
 * profile, harness, look) on a fresh shared desk, a fresh channel, and the
 * team's section kept. Messages are not copied, like bot duplicate.
 */
app.post("/api/teams/:id/duplicate", async (req, res) => {
  const src = await teams.getTeam(req.params.id);
  if (!src) return res.status(404).json({ error: "not found" });
  const bots = await store.loadBots() as IndexBot[];
  const members = teams.membersOf(src, bots) as IndexBot[];
  if (!members.length) return res.status(409).json({ error: "This team has no members to copy." });
  const name = `${src.name || "Team"} copy`;
  const teamId = randomUUID();
  const created: IndexBot[] = [];
  let desk = null;
  // Chief first so the shared desk is created for it, as team create does.
  for (const m of [...members].sort((a, b) => (a.teamRole === "chief" ? -1 : 0) - (b.teamRole === "chief" ? -1 : 0)).slice(0, 6)) {
    const role = m.teamRole === "chief" ? "chief" : "worker";
    const bot = store.newBot({
      name: m.name,
      title: m.title,
      description: m.description,
      instructions: m.instructions,
      color: m.color,
      avatar: m.avatar,
      harness: m.harness,
      teamId,
      teamRole: role,
      section: src.section,
    }) as IndexBot;
    if (!desk) {
      desk = await computers.ensureComputerForBot(bot as computers.ComputerBot);
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
  vm.applyTeamDisplays({ chiefId: chief?.id, memberIds: created.map((b) => b.id) }, created as vm.Bot[], desk?.novncPort || null);
  for (const b of created) await store.upsertBot(b);
  const team = await teams.saveTeam({
    id: teamId,
    name,
    chiefId: chief?.id || null,
    memberIds: created.map((b) => b.id),
    computerId: desk?.id || null,
    section: src.section || "",
  });
  broadcast("bots", (await store.loadBots()).map(toClient));
  broadcast("computers", { dirty: true });
  broadcast("teams", await publicTeams());
  res.json({ ...team, chiefId: chief?.id || null, members: created.map((b) => ({ id: b.id, name: b.name, role: b.teamRole, color: b.color })), messages: [] });
  if (chief) provision(chief.id).catch((err) => console.log("provision", err));
});

app.delete("/api/teams/:id", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const wipe = req.body?.wipe !== false && String(req.query.wipe || "1") !== "0";
  const bots = await store.loadBots() as IndexBot[];
  const members = teams.membersOf(team, bots);
  // `membersOf` hands back the rows it was given, so `vm.computerId` comes off
  // @sub8/store's index signature as `unknown`; `getComputer` takes the id.
  const computerId = (team.computerId as string | null | undefined) || (members[0] as IndexBot | undefined)?.vm?.computerId || null;
  for (const m of members) {
    stopTurn(m.id);
    deletedIds.add(m.id);
    await store.deleteBot(m.id);
  }
  await teams.removeTeam(team.id);
  if (wipe && computerId) {
    const row = await computers.getComputer(computerId);
    if (row) {
      await vm.stopVm({ vm: { container: row.container, volume: row.volume } } as vm.Bot, { wipe: true }).catch(() => {});
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
  spendGuard.noteUserActivity();
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
  const bots = await store.loadBots() as IndexBot[];
  const members = teams.membersOf(team, bots);
  const asked = Array.isArray(req.body?.toIds) ? req.body.toIds.map(String).filter(Boolean) : [];
  const tagged = teams.mentionedMemberIds(posted.content, members);
  const targets = [...new Set([...asked, ...tagged])].filter((id) => members.some((b) => b.id === id));
  // `filter(Boolean)` drops the empty team's `undefined`; TypeScript does not
  // read that, so the ids it leaves behind are stated here.
  // An un-mentioned message goes to the lead. The chief decides whether and
  // how to delegate (create_teammate / message_teammate / set_job) — the
  // server no longer pre-assigns every worker a job step on the first message,
  // which turned a plain "hi" into a three-step job card.
  const deliver = targets.length ? targets : ([team.chiefId || team.memberIds?.[0]].filter(Boolean) as string[]);
  for (const id of deliver) {
    if (id === team.chiefId) {
      // The lead reads its messages when it gets to them — see scheduleLeadTurn.
      scheduleLeadTurn(id, { posted, images });
      continue;
    }
    await store.patchBot(id, (b) => {
      b.messages = b.messages || [];
      userSpoke(b);
      b.messages.push({ ...posted, role: "user" });
    });
    broadcast("message", { botId: id, ...posted });
    // `appendMessage` answers a stored row, whose `content` sits under
    // @sub8/store's index signature; this route wrote it as a string one call up.
    enqueueTurn(id, () => runUserTurn(id, posted.content as string, false, images, { persistUser: false, source: "user" }));
  }
  res.json({ ok: true, message: posted, toIds: deliver });
});

app.put("/api/teams/:id/job", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const saved = await teams.setTeamJob(team.id, {
    title: req.body?.title,
    steps: req.body?.steps,
  });
  // `setTeamJob` answers null only for a team id it cannot load; `getTeam` two
  // lines up already proved this one, and the 404 above is the other path.
  broadcast("job", { teamId: team.id, job: saved!.job });
  if (saved!.renamed?.length) broadcast("bots", (await store.loadBots()).map(toClient));
  broadcast("teams", await publicTeams());
  res.json(saved!.job);
});

app.patch("/api/teams/:id/job", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const bumped = await teams.patchTeamStep(team.id, req.body || {});
  if (!bumped?.step) return res.status(404).json({ error: "step not found" });
  broadcast("job", { teamId: team.id, job: bumped.job });
  if (bumped.renamed?.length) broadcast("bots", (await store.loadBots()).map(toClient));
  broadcast("teams", await publicTeams());
  res.json(bumped.job);
});

app.delete("/api/teams/:id/job", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  await teams.clearTeamJob(team.id);
  broadcast("job", { teamId: team.id, job: null });
  broadcast("teams", await publicTeams());
  res.json({ ok: true });
});

app.patch("/api/teams/:id", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  const patch: { name?: string; section?: string; pinned?: boolean; hidden?: boolean } = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
  if ("section" in (req.body || {})) patch.section = String(req.body.section || "");
  if ("pinned" in (req.body || {})) patch.pinned = Boolean(req.body.pinned);
  if ("hidden" in (req.body || {})) patch.hidden = Boolean(req.body.hidden);
  const saved = await teams.saveTeam({ ...team, ...patch });
  broadcast("teams", await publicTeams());
  res.json(saved);
});

app.post("/api/teams/:id/focus", async (req, res) => {
  const team = await teams.getTeam(req.params.id);
  if (!team) return res.status(404).json({ error: "not found" });
  // Same as the attach route: a missing botId reaches `getBot` as undefined and
  // comes back null, which is the 404 on the next line.
  const bot = await store.getBot(req.body?.botId as string) as IndexBot | null;
  if (!bot || bot.teamId !== team.id) return res.status(404).json({ error: "not on this team" });
  const claimed = await vm.focusOwnedWindow(bot as vm.Bot).catch(() => null);
  if (claimed && bot.vm) {
    bot.vm.windowId = claimed.windowId;
    bot.vm.windowTitle = claimed.title;
    await store.upsertBot(bot);
  }
  res.json({ ok: true, window: claimed, bot: toClient(bot) });
});

function sendChannelError(res: Response, err: unknown) {
  const error = String((err as Error)?.message || err);
  if (/not found/i.test(error)) return res.status(404).json({ error });
  if (/required|empty|max 6|UUID|last member|missing/i.test(error)) return res.status(400).json({ error });
  console.error("channels", err);
  return res.status(500).json({ error });
}

app.get("/api/channels", async (_req, res) => {
  try {
    res.json(await channels.listChannels());
  } catch (err) {
    sendChannelError(res, err);
  }
});

app.post("/api/channels", async (req, res) => {
  try {
    const body = req.body || {};
    const row = await channels.createChannel({
      name: body.name,
      memberIds: body.memberIds,
      description: body.description,
    });
    syncChannelDesk(row);
    broadcast("channels", await channels.listChannels());
    res.json(row);
  } catch (err) {
    sendChannelError(res, err);
  }
});

app.get("/api/channels/:id", async (req, res) => {
  try {
    const row = await channels.getChannel(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (err) {
    sendChannelError(res, err);
  }
});

// Membership edits are POST /api/channels/:id/members { add?: string[], remove?: string[] } (not PATCH).
app.post("/api/channels/:id/members", async (req, res) => {
  try {
    const existing = await channels.getChannel(req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const body = req.body || {};
    const add = Array.isArray(body.add) ? body.add : [];
    const remove = Array.isArray(body.remove) ? body.remove : [];
    let row = existing;
    if (existing.memberIds.length >= channels.MAX_MEMBERS && add.length && remove.length) {
      for (const memberId of remove) row = await channels.removeMember(row, memberId);
      for (const memberId of add) row = await channels.addMember(row, memberId);
    } else {
      for (const memberId of add) row = await channels.addMember(row, memberId);
      for (const memberId of remove) row = await channels.removeMember(row, memberId);
    }
    syncChannelDesk(row);
    broadcast("channels", await channels.listChannels());
    res.json(row);
  } catch (err) {
    sendChannelError(res, err);
  }
});

app.get("/api/bots/:id/trace", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const { read } = await import("@sub8/store/trace");
  res.json({ botId: bot.id, events: await read(bot.id, Number(req.query.limit) || 80) });
});

app.get("/api/bots/:id", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const all = bot.messages || [];
  if (req.query.before || req.query.beforeTs) {
    let i = req.query.before ? all.findIndex((m) => String(m.id) === String(req.query.before)) : -1;
    if (i < 0 && req.query.beforeTs) {
      const ts = Number(req.query.beforeTs);
      if (Number.isFinite(ts)) {
        i = all.findIndex((m) => (m.ts || 0) >= ts);
        if (i < 0) i = all.length;
      }
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    if (i <= 0) {
      return res.json({
        id: bot.id,
        messages: [],
        hasMore: false,
      });
    }
    const start = Math.max(0, i - limit);
    const slice = all.slice(start, i);
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
  // `BotSeed` is the same JSON this body carries, spelled for the store.
  const bot = store.newBot(req.body as store.BotSeed || {});
  const row = await computers.ensureComputerForBot(bot as computers.ComputerBot);
  // `row!`: `ensureComputerForBot` answers null for a null bot and nothing else.
  bot.vm = {
    ...bot.vm,
    computerId: row!.id,
    container: row!.container,
    volume: row!.volume,
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
  const src = await store.getBot(req.params.id) as IndexBot | null;
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
  const row = await computers.ensureComputerForBot(copy as computers.ComputerBot);
  // `row!`: `ensureComputerForBot` answers null for a null bot and nothing else.
  copy.vm = {
    ...copy.vm,
    computerId: row!.id,
    container: row!.container,
    volume: row!.volume,
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
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const settings = await store.loadSettings();
  const prevEffective = harnessFor(bot as AgentBotRow, settings as Parameters<typeof harnessFor>[1]).provider;
  const prevIdentity = String(bot.identityId || "");
  const body = { ...req.body };
  if (typeof body.identityId === "string" && body.identityId) {
    const pool = await identities.loadNormalizedIdentities();
    const picked = pool.find((row) => row.id === body.identityId);
    if (picked) {
      // Switching providers must not carry the previous provider's model over
      // (e.g. a Cursor "cursor-grok-4.6-low" left on a bot now on Claude). Keep
      // the current model only when the provider is unchanged; otherwise take
      // the new identity's model, or let the harness resolve its own default.
      const carriedModel = bot.harness?.provider === picked.provider ? bot.harness?.model : undefined;
      bot.harness = { ...(bot.harness || {}), provider: picked.provider, model: body.harness?.model || carriedModel || picked.model || "" };
    }
  }
  if (body.avatar && typeof body.avatar === "object") {
    // All three drawn fields persist, plus an optional user photo. Sending
    // photo as "" or null clears it; omitting it keeps whatever was there.
    const hasPhotoKey = Object.prototype.hasOwnProperty.call(body.avatar, "photo");
    const photo = hasPhotoKey
      ? (typeof body.avatar.photo === "string" && body.avatar.photo ? body.avatar.photo : undefined)
      : bot.avatar?.photo;
    bot.avatar = {
      expression: body.avatar.expression || bot.avatar?.expression || "neutral",
      animation: body.avatar.animation || bot.avatar?.animation || "idle",
      body: body.avatar.body || bot.avatar?.body || "rounder",
      ...(photo ? { photo } : {}),
    } as store.BotAvatar;
    delete body.avatar;
  }
  Object.assign(bot, body, { id: bot.id, vm: bot.vm, messages: bot.messages, routines: bot.routines });
  const nextEffective = harnessFor(bot as AgentBotRow, settings as Parameters<typeof harnessFor>[1]).provider;
  const nextIdentity = String(bot.identityId || "");
  if (hostCli.shouldRotateHarnessSession(prevEffective, nextEffective) || (prevIdentity && nextIdentity && prevIdentity !== nextIdentity)) {
    bot.harnessSessionId = randomUUID();
    bot.grokSessionId = bot.harnessSessionId;
    bot.harnessSessionFresh = true;
  }
  await store.upsertBot(bot);
  broadcast("bot", toClient(bot));
  res.json(toClient(bot));
});

const deletedIds = new Set<string>();

/** What `liveComputers` hands `decorateComputer` so one pass builds the maps once. */
interface DecorateExtra {
  byId?: Map<string, IndexBot> | undefined;
  attached?: Map<unknown, IndexBot> | undefined;
  attachedList?: IndexBot[] | undefined;
  fields?: Record<string, unknown> | undefined;
}

function decorateComputer(row: computers.Computer, bots: IndexBot[], settings: store.Settings, extra: DecorateExtra = {}) {
  const byId = extra.byId || new Map(bots.map((b) => [b.id, b]));
  // `b.vm!`: the filter on the same line is what proves it.
  const attached = extra.attached || new Map(bots.filter((b) => b.vm?.computerId).map((b) => [b.vm!.computerId, b]));
  const attachedBot = attached.get(row.id) || null;
  const bot = attachedBot || (row.lastBotId ? byId.get(row.lastBotId) : null);
  const owner = attachedBot || bot;
  const h = owner ? harnessFor(owner as AgentBotRow, settings as AgentSettings) : null;
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
      ? { provider: h.provider, model: h.model || "", label: (HARNESS_PROVIDERS.find((p) => p.id === h.provider) || ({} as { label?: string })).label || h.provider }
      : null,
    ...extra.fields,
  };
}

async function staleComputers(docker: vm.DecoratedDockerStatus) {
  const [rows, bots, settings] = await Promise.all([computers.listComputers(), store.loadBots() as Promise<IndexBot[]>, store.loadSettings()]);
  return rows.map((row) =>
    decorateComputer(row, bots, settings, {
      fields: { stale: true, stuck: Boolean(docker?.stuck), exists: row.status !== "missing" },
    }),
  );
}

async function liveComputers() {
  const [rows, bots, settings, list] = await Promise.all([
    computers.listComputers(),
    store.loadBots() as Promise<IndexBot[]>,
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
    const st = list.states.get(row.container) || ({ status: "missing", exists: false, running: false, paused: false } as vm.ContainerState);
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
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const keepComputer = req.body?.keepComputer !== false && String(req.query.keepComputer || "") !== "0";
  deletedIds.add(bot.id);
  // A teammate on a shared desk owns one X display: tear it down (Chrome and
  // all) or the desk keeps paying pids/memory for a bot that no longer exists.
  if (bot.vm?.container && vm.displayNum(bot as vm.Bot) > 1) {
    vm.stopDisplay(bot.vm.container, vm.displayNum(bot as vm.Bot)).catch(() => {});
  }
  const row = await computers.ensureComputerForBot(bot as computers.ComputerBot).catch(() => null);
  try {
    if (keepComputer) {
      if (row) await computers.saveComputer({ ...row, lastBotId: bot.id, pausedByQuit: false });
    } else {
      await vm.stopVm(bot as vm.Bot, { wipe: true });
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
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  try {
    const health = await vm.streamHealth(bot as vm.Bot);
    if (health.novncPort && bot.vm?.novncPort !== health.novncPort) {
      bot.vm = { ...bot.vm, novncPort: health.novncPort };
      await store.upsertBot(bot);
      if (vm.displayNum(bot as vm.Bot) <= 1 && bot.vm.computerId) {
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
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/bots/:id/screen", async (req, res) => {
  const dir = path.join(dataDir, "screens");
  // `:id` reaches us percent-DECODED — express matches the still-encoded
  // pathname and decodes after — so a `%2F..%2F` id was a real traversal, and
  // path.join walked straight out of data/screens. Every other :id route
  // resolves through a registry lookup (store.getBot, computers.getComputer)
  // and simply 404s on a junk id; this was the one that put a raw param into a
  // path. Resolve and require the result to sit DIRECTLY in the directory,
  // which holds whatever the id is encoded as. The 404-vs-200 split otherwise
  // also answered "does this file exist" for anything ending .png.
  const file = path.resolve(dir, `${req.params.id}.png`);
  if (path.dirname(file) !== path.resolve(dir)) return res.status(404).end();
  try {
    res.type("png").send(await fs.readFile(file));
  } catch {
    res.status(404).end();
  }
});

app.post("/api/bots/:id/vm", async (req, res) => {
  const action = req.body?.action || "start";
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  try {
    if (action === "reboot") {
      const row = bot.vm?.container ? { container: bot.vm.container, id: bot.vm.computerId, novncPort: bot.vm.novncPort } : await computers.ensureComputerForBot(bot as computers.ComputerBot);
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
        // `saveComputer` merges into the stored row; an absent port and a null one
      // reach `newComputer` the same way.
      if (full) await computers.saveComputer({ ...full, status: "running", novncPort: bot.vm.novncPort as number | null, pausedByQuit: false });
      }
      broadcast("bot", toClient(bot));
      broadcast("computers", { dirty: true });
      return res.json(toClient(bot));
    }
    if (action === "reset") await vm.stopVm(bot as vm.Bot, { wipe: false });
    const row = await computers.ensureComputerForBot(bot as computers.ComputerBot);
    // `row!` here and below: `ensureComputerForBot` answers null for a null bot
    // and nothing else, and `bot` came off a 404 guard at the top of the route.
    bot.vm = { ...bot.vm, computerId: row!.id, container: row!.container, volume: row!.volume, detached: false };
    const info = await vm.startVm(
      bot as vm.Bot,
      (m) => broadcast("log", { botId: bot.id, m }),
      async () => deletedIds.has(bot.id) || !(await store.getBot(bot.id)),
    );
    bot.vm = { ...bot.vm, ...info, computerId: row!.id, error: null, detached: false, hint: "" };
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
    bot.vm = { ...bot.vm, status: "error", error: (err as Error).message };
    await store.upsertBot(bot);
    broadcast("bot", toClient(bot));
    res.status(500).json({ error: (err as Error).message });
  }
});

const turnLocks = new Map<string, Promise<unknown>>();
const turnEpoch = new Map<string, number>();
const turnAbort = new Map<string, AbortController>();
/** Chat lines that arrived while a turn was already running, per bot. */
const inflightTurns = new Map<string, { nudges: string[] }>();

/**
 * Team-channel messages waiting for the lead. A message is posted to the
 * channel the moment it arrives (the user sees it), but the lead's OWN copy is
 * held here and delivered when its turn starts. Pushing it into the lead's
 * thread immediately meant the turn for message 1 already saw message 2 in
 * context and acted on it — and then the turn for message 2 did it again (the
 * double "→ Pixel: Say a random number"). Draining at turn start also folds a
 * burst into ONE turn, which is how the lead "handles several requests".
 */
type PendingChannelMsg = { posted: store.Message; images: string[] };
const pendingForLead = new Map<string, PendingChannelMsg[]>();
const leadTurnQueued = new Set<string>();

/**
 * A user message answers whatever the bot was waiting on. awaitingUserSelection
 * was cleared only by an explicit pick; a free-text reply — 1:1 or in the
 * channel — left the bot "awaiting" forever with send_message blocked
 * (AWAITING_BLOCKED), which is how a lead went silent for four minutes.
 */
function userSpoke(b: { awaitingUserSelection?: boolean | undefined; messages?: store.Message[] | undefined }): void {
  b.awaitingUserSelection = false;
  for (const m of b.messages || []) {
    if ((m.kind === "choices" || m.kind === "secret-request") && m.pending !== false) m.pending = false;
  }
}

function scheduleLeadTurn(botId: string, msg: PendingChannelMsg): void {
  (pendingForLead.get(botId) || pendingForLead.set(botId, []).get(botId)!).push(msg);
  if (leadTurnQueued.has(botId)) return; // the queued turn will drain this too
  leadTurnQueued.add(botId);
  enqueueTurn(
    botId,
    async () => {
      leadTurnQueued.delete(botId);
      const batch = pendingForLead.get(botId) || [];
      pendingForLead.set(botId, []);
      if (!batch.length) return;
      await store.patchBot(botId, (b) => {
        b.messages = b.messages || [];
        userSpoke(b);
        for (const { posted } of batch) b.messages.push({ ...posted, role: "user" });
      });
      for (const { posted } of batch) broadcast("message", { botId, ...posted });
      const images = batch.flatMap((m) => m.images);
      const text =
        batch.length === 1
          ? String(batch[0]!.posted.content || "")
          : `The user sent ${batch.length} messages in the team channel. Handle all of them:\n${batch.map((m, i) => `${i + 1}. ${String(m.posted.content || "")}`).join("\n")}`;
      return runUserTurn(botId, text, false, images, { persistUser: false, source: "user" });
    },
    () => leadTurnQueued.delete(botId),
  );
}

/**
 * Merge a change into bot.vm UNDER the store lock.
 *
 * `bot` on these routes was read at entry, before a Docker call that can take
 * seconds. Writing the whole row back afterwards is a lost update against
 * anything that landed meanwhile -- and since upsertBot now preserves `vm` from
 * a newer row, the freshly computed status is the thing that gets dropped, so
 * a paused container keeps reading "running" and ensureDesktops never corrects
 * it. patchBot re-reads inside the lock, so only the fields named here move.
 */
async function patchVm(botId: string, change: Record<string, unknown>): Promise<void> {
  const next = (await store.patchBot(botId, (b) => {
    (b as IndexBot).vm = { ...((b as IndexBot).vm || {}), ...change } as IndexBot["vm"];
  })) as IndexBot | null;
  if (next) broadcast("bot", toClient(next));
}

function epochOf(id: string): number {
  return turnEpoch.get(id) || 0;
}

/**
 * Take control, persisted to the bot row.
 *
 * `held` in @sub8/control is an in-memory Set with no backing store, so a host
 * restart while the human was driving silently reported "nobody is driving".
 * That is not a quiet window: within 5s drainLeftoverWakes fires any queued
 * wake and within 15s tickRoutines fires that bot's routines, and agent.mts's
 * "the human has the mouse" refusal is gone with the flag — so the model
 * resumes clicking and typing on the very display the human still has. Wakes
 * are durable and survive the restart the flag did not, which is what makes the
 * window real rather than theoretical. Restart is a first-class flow here: boot
 * runs resumePausedByQuit() precisely to bring back what quitting paused.
 *
 * The cloud sibling already persists this (brain.ts writes
 * human:<userId>:<computerId> to KV and re-hydrates it every turn); only the
 * local path did not, which is what marks it an oversight rather than a choice.
 */
async function holdHumanControl(botId: string, on: unknown): Promise<void> {
  setHumanControl(botId, on);
  try {
    await store.patchBot(botId, (b) => {
      (b as { humanControl?: boolean }).humanControl = Boolean(on);
    });
  } catch {
    /* best effort — an unpersisted flag is the old behaviour, not worse than it */
  }
}

/** Re-arm Take control for bots that were being driven when the host stopped. */
async function restoreHumanControl(): Promise<number> {
  let n = 0;
  try {
    for (const b of await store.loadBots()) {
      if ((b as { humanControl?: boolean }).humanControl) {
        setHumanControl(b.id, true);
        n += 1;
      }
    }
  } catch {
    /* no bots yet */
  }
  return n;
}

/**
 * `onSkipped` runs when the epoch guard discards the turn instead of running it.
 *
 * The guard exists so a Stop, or a turn that ended on a card, cannot be followed
 * by work queued before it. But a discarded turn is silent, and a caller that
 * already consumed something durable to get here has then lost it — see
 * fireDurableWake.
 */
function enqueueTurn(botId: string, fn: () => unknown, onSkipped?: () => void): Promise<unknown> {
  const epoch = epochOf(botId);
  const run = () => {
    if (epochOf(botId) !== epoch) {
      onSkipped?.();
      return;
    }
    return fn();
  };
  const prev = turnLocks.get(botId) || Promise.resolve();
  const next = prev.then(run, run);
  turnLocks.set(botId, next.catch(() => {}));
  return next;
}

const notifiedThisTurn = new Set<string>();

/**
 * Per lead: the teammates it has handed work to and not yet heard back from,
 * and the replies gathered so far. The lead's report turn runs ONCE, when the
 * set is complete (or after REPORT_FLUSH_MS) — not on every reply. Per-reply
 * turns raced the still-working teammates: Nova's "hello" woke the lead, which
 * saw Pixel outstanding and handed Pixel the same thing again. Batched, the
 * lead sees every answer together and can combine them or stay silent.
 */
const REPORT_FLUSH_MS = 3 * 60 * 1000;
const outstandingFor = new Map<string, Set<string>>();
const repliesFor = new Map<string, { name: string; text: string; explicit?: boolean }[]>();
const reportFlushTimer = new Map<string, NodeJS.Timeout>();

function noteHandedOff(chiefId: string, workerId: string): void {
  (outstandingFor.get(chiefId) || outstandingFor.set(chiefId, new Set()).get(chiefId)!).add(workerId);
}
function notifyKey(fromId: string | undefined, toId: string | null | undefined): string {
  return `${fromId || ""}->${toId || ""}`;
}

/**
 * message_teammate, done by the server. The per-desk MCP subprocess used to
 * do all of this itself — thirty-odd store reads and writes, each a cross-
 * process file lock against a server that is writing bots.json many times a
 * second during a team burst. Under contention the tool timed out or threw
 * "lock timeout", and the lead told the user its teammates were unreachable.
 * The server owns the store; the subprocess now just asks it (one HTTP call).
 * The in-process tool path (agent.mts) keeps its own copy for now.
 */
async function teammateMessage({
  fromId,
  to,
  content,
  label,
  status,
  detail,
  stepId,
}: {
  fromId: string;
  to: string;
  content: string;
  label?: string | undefined;
  status?: string | undefined;
  detail?: string | undefined;
  stepId?: string | undefined;
}): Promise<{ ok: boolean; text: string; isError?: boolean }> {
  const bot = await store.getBot(fromId) as IndexBot | null;
  if (!bot) return { ok: false, text: "sender not found", isError: true };
  const body = vault.redactSecrets(teammate.sendToAgentContent(content), await vault.listSecrets());
  if (!body) return { ok: false, text: "empty message — pass the note in `content`", isError: true };
  const room = await channels.getChannel(to).catch(() => null);
  if (room) {
    const routed = await teammate.sendToAgent(bot.id, to, body) as { queued: number; channelId: string };
    return { ok: true, text: `queued to room ${routed.channelId} (${routed.queued} members)` };
  }
  const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
  const allBots = await store.loadBots() as IndexBot[];
  const members = team ? teams.membersOf(team, allBots) : [];
  const mate = teams.resolveTeammate(to, members);
  if (!mate) {
    const target = teams.resolveTeammate(to, members, allBots) || (await store.getBot(to));
    if (!target) {
      const names = members.filter((b) => b.id !== bot.id).map((b) => b.name).filter(Boolean).join(", ");
      return { ok: false, text: `bot not found: "${to}". Pass bot_id from list_teammates${names ? ` (your teammates: ${names})` : ""}.`, isError: true };
    }
    const routed = await teammate.sendToAgent(bot.id, target.id, body) as { queued: number; botId: string };
    return { ok: true, text: `queued to ${routed.botId}` };
  }
  const teamId = bot.teamId as string;
  const posted = await teams.appendMessage(teamId, {
    role: "assistant",
    speakerId: bot.id,
    speakerName: bot.name,
    speakerRole: bot.teamRole || "",
    toId: mate.id,
    toName: mate.name,
    content: body,
  });
  broadcast("team-message", { teamId, ...posted });
  const note = {
    id: posted.id,
    role: "assistant",
    speakerId: bot.id,
    speakerName: bot.name,
    speakerRole: bot.teamRole || "",
    toId: mate.id,
    toName: mate.name,
    content: `To ${mate.name}: ${body}`,
    ts: posted.ts,
  };
  await store.patchBot(bot.id, (b) => {
    b.messages = b.messages || [];
    if (!b.messages.some((m) => m.id === note.id)) b.messages.push(note);
  });
  broadcast("message", { botId: bot.id, ...note });
  dispatchToTeammate(mate.id, body, bot);
  const st = teams.TASK_STATUSES.includes(status as teams.TaskStatus) ? (status as teams.TaskStatus) : null;
  const announce = (renamed: { id: string; name?: string; teamId?: string; teamRole?: string; color?: string; harness?: unknown; vm?: unknown; description?: string }[] = []) => {
    for (const b of renamed) broadcast("teammate", { bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description } });
  };
  if (bot.teamRole === "chief") {
    const assigned = await teams.onWorkerAssigned(teamId, mate.id, { label, content: body, status: st, detail, stepId });
    if (assigned?.team?.job) broadcast("job", { teamId, job: assigned.team.job });
    announce(assigned?.renamed as Parameters<typeof announce>[0]);
    return { ok: true, text: `sent to ${assigned?.bot?.name || mate.name}` };
  }
  if (st) {
    const bumped = await teams.patchTeamStep(teamId, { botId: bot.id, status: st, detail: detail || body.slice(0, 160) });
    if (bumped?.job) broadcast("job", { teamId, job: bumped.job });
    announce(bumped?.renamed as Parameters<typeof announce>[0]);
  }
  return { ok: true, text: `sent to ${mate.name}` };
}

function dispatchToTeammate(toId: string, content: unknown, from: DispatchFrom | null | undefined): void {
  const text = String(content || "").trim();
  if (!toId || !text) return;
  if (from?.teamRole !== "chief") {
    notifiedThisTurn.add(notifyKey(from?.id, toId));
    deliverTeammateReply(toId, from, text.slice(0, 240), { explicit: true });
    return;
  }
  const who = from?.name || "a teammate";
  const role = from?.teamRole || "teammate";
  if (from?.id) noteHandedOff(from.id, toId);
  const run = async () => {
    const live = await store.getBot(toId) as IndexBot | null;
    if (!live) return;
    const followUp = teammate.isFollowUpDispatch(live.messages);
    const incoming = {
      id: `u${Date.now()}tm`,
      role: "user",
      speakerId: from?.id || "teammate",
      speakerName: who,
      speakerRole: from?.teamRole || "",
      content: teammate.storedChiefToWorker(who, text),
      ts: Date.now(),
    };
    await store.patchBot(toId, (b) => {
      b.messages = b.messages || [];
      b.messages.push(incoming);
    });
    broadcast("message", { botId: toId, ...incoming });
    const prompt = teammate.wrapWorkerDispatch({ who, role, text });
    const inflight = inflightTurns.get(toId);
    if (inflight && followUp) {
      inflight.nudges.push(prompt);
      return;
    }
    return runUserTurn(toId, prompt, false, [], { persistUser: false, replyTo: from?.id || null });
  };
  if (inflightTurns.get(toId)) {
    void run();
    return;
  }
  enqueueTurn(toId, run);
}

async function shortStepPing(bot: IndexBot | null | undefined): Promise<string> {
  if (!bot?.teamId) return "done";
  const team = await teams.getTeam(bot.teamId);
  const step = team?.job ? teams.findStep(team.job, { botId: bot.id }) : null;
  if (step?.detail) return `${step.status}: ${step.detail}`;
  if (step) return `${step.label} ${step.status}`;
  return "done";
}

/**
 * The lead's final message is its reply to the user — the same rule workers
 * have (deliverWorkerAnswer); `claude -p` returns its answer as final text.
 * One structural exception: on a turn where the lead handed work off, the
 * delegation line IS the reply and its closing text ("message sent, waiting
 * for her hello…") is not shown — anything else it wants the user to see on
 * such a turn goes through send_message, a deliberate act. Tools express
 * intent; no reading of the words. Report turns and plain turns deliver the
 * text (a computed sum, an answer); silence is nothing_to_add.
 */
async function deliverLeadAnswer(bot: IndexBot | null | undefined, last: { content?: unknown } | null | undefined, since: number): Promise<void> {
  if (bot?.teamRole !== "chief" || !bot.teamId || !last) return;
  const content = String(last.content || "").trim();
  if (!content) return;
  // The model sometimes WRITES the tool's name instead of calling it. That is
  // the quiet end it meant, not a message for the user.
  if (content === "nothing_to_add") return;
  const recent = (await teams.loadMessages(bot.teamId)).slice(-30);
  const handedOffThisTurn = recent.some((m) => m.speakerId === bot.id && Boolean(m.toId) && Number(m.ts || 0) >= since);
  if (handedOffThisTurn) return;
  // Same rule as workers: a send_message this turn IS the answer — the closing
  // plain text ("Sent.") must not land as a second bubble.
  const spokeThisTurn = recent.some((m) => m.speakerId === bot.id && !m.toId && Number(m.ts || 0) >= since && String(m.content || "").trim());
  if (spokeThisTurn) return;
  const posted = await teams.appendMessage(bot.teamId, {
    role: "assistant",
    speakerId: bot.id,
    speakerName: bot.name,
    speakerRole: "chief",
    content,
  });
  broadcast("team-message", { teamId: bot.teamId, ...posted });
}

async function finalizeChiefJob(bot: IndexBot | null | undefined) {
  if (bot?.teamRole !== "chief" || !bot.teamId) return null;
  const team = await teams.getTeam(bot.teamId);
  const { job, finalized } = teams.maybeFinalizeSummary(team?.job);
  if (!finalized) return null;
  const saved = await teams.saveTeam({ ...team, job });
  // `team!`: `maybeFinalizeSummary` only says `finalized` for a job it was
  // given, and the only job here is `team.job`.
  broadcast("job", { teamId: team!.id, job: saved.job });
  broadcast("teams", await publicTeams());
  return saved.job;
}

async function deliverTeammateReply(toId: string | null | undefined, from: DispatchFrom | null | undefined, content: unknown, { explicit = false }: { explicit?: boolean } = {}): Promise<void> {
  if (!toId || !content || toId === from?.id) return;
  const short = String(content || "").trim().slice(0, 240);
  const to = await store.getBot(toId) as IndexBot | null;
  const stored = to?.teamRole === "chief"
    ? teammate.chiefReportStored(from?.name, short)
    : `${from?.name || "Teammate"}: ${short}`;
  const incoming = {
    id: `a${Date.now()}rp`,
    role: "assistant",
    speakerId: from?.id,
    speakerName: from?.name,
    speakerRole: from?.teamRole || "",
    toId,
    content: stored,
    ts: Date.now(),
  };
  const liveBot = await store.patchBot(toId, (b) => {
    b.messages = b.messages || [];
    b.messages.push(incoming);
  });
  if (!liveBot) return;
  broadcast("message", { botId: toId, ...incoming });
  const team = from?.teamId ? await teams.getTeam(from.teamId) : (to?.teamId ? await teams.getTeam(to.teamId) : null);
  // Context for the lead, from the channel's own rows (a directed message
  // carries toName + the raw text): the user's request, and everything the
  // lead handed out since then.
  let userAsk = "";
  const handed: string[] = [];
  if (to?.teamRole === "chief" && team) {
    const rows = await teams.loadMessages(team.id);
    let askIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.speakerRole === "user") { askIdx = i; break; }
    }
    userAsk = askIdx >= 0 ? String(rows[askIdx]!.content || "").trim() : "";
    for (const m of rows.slice(askIdx >= 0 ? askIdx : 0)) {
      if (m.speakerId === to.id && m.toName) handed.push(`${m.toName}: ${String(m.content || "").trim()}`);
    }
  }
  const runReport = (llm: string) => {
    const live = inflightTurns.get(toId);
    if (live) live.nudges.push(llm);
    else enqueueTurn(toId, () => runUserTurn(toId, llm, false, [], { persistUser: false, source: "report" }));
  };
  if (to?.teamRole !== "chief") {
    runReport(stored);
    return;
  }
  // Batch: gather this reply; run the lead's report turn only when every
  // teammate it handed work to has answered (or the flush timer fires).
  const pending = outstandingFor.get(toId);
  if (from?.id && pending) pending.delete(from.id);
  const gathered = repliesFor.get(toId) || repliesFor.set(toId, []).get(toId)!;
  gathered.push({ name: String(from?.name || "Teammate"), text: short, explicit });
  const flush = () => {
    const t = reportFlushTimer.get(toId);
    if (t) clearTimeout(t);
    reportFlushTimer.delete(toId);
    const replies = repliesFor.get(toId) || [];
    repliesFor.set(toId, []);
    outstandingFor.set(toId, new Set());
    if (!replies.length) return;
    const only = replies.length === 1 ? replies[0]! : null;
    // Event policy, not word-parsing: wake the lead only when there is
    // something to decide. One automatic answer to a one-piece ask needs no
    // lead turn — the user already sees it, and a turn here only ever produced
    // "Got it! What next?". Several answers (combine), a tracked job, or a
    // teammate that explicitly messaged the lead (a tool call = intent) do wake it.
    // The lead always hears a completed handoff set — one coalesced turn. The
    // old skip for "a single answered handoff with no tracked job" kept the
    // channel quiet for "ask bot1 to say hello", but it also dropped the
    // lead's own follow-up work ("when Echo is done, read the file and tell
    // me…"). Silence is the lead's call now: nothing_to_add.
    runReport(
      teammate.chiefReportLlm(only ? only.name : "Your teammates", only ? only.text : "", {
        userAsk,
        handed: [...new Set(handed)],
        replies: only ? undefined : replies,
      }),
    );
  };
  if (!pending || pending.size === 0) {
    flush();
    return;
  }
  if (!reportFlushTimer.has(toId)) reportFlushTimer.set(toId, setTimeout(flush, REPORT_FLUSH_MS));
}

/**
 * A worker finished a turn the lead started. Its ANSWER — the actual final
 * reply, not a job-step ping — goes two places: the team channel, as the
 * worker's own bubble (this is "Nova: hello"), and the lead's thread as a
 * report so the lead can combine or take the next step. The old path sent
 * only shortStepPing ("done") unless the worker remembered a tool, which is
 * how a worker could say hello and the lead hear nothing.
 */
async function deliverWorkerAnswer(chiefId: string, worker: IndexBot | null | undefined, fallback: string, since = 0): Promise<void> {
  if (!worker || !chiefId) return;
  if (worker.teamId) {
    // The worker already spoke in the channel this turn (send_message): that
    // is its answer — report it to the lead, and do not also post its closing
    // plain text as a second bubble.
    const recent = (await teams.loadMessages(worker.teamId)).slice(-30);
    const spoke = recent.filter((m) => m.speakerId === worker.id && !m.toId && Number(m.ts || 0) >= since && String(m.content || "").trim());
    if (since > 0 && spoke.length) {
      await deliverTeammateReply(chiefId, worker, String(spoke[spoke.length - 1]!.content).trim());
      return;
    }
  }
  const last = [...(worker.messages || [])]
    .reverse()
    .find((m) => m.role === "assistant" && String(m.content || "").trim() && !m.kind && !m.toId && (since <= 0 || Number(m.ts || 0) >= since));
  const answer = String(last?.content || "").trim() || fallback;
  if (!answer) return;
  if (worker.teamId) {
    const posted = await teams.appendMessage(worker.teamId, {
      role: "assistant",
      speakerId: worker.id,
      speakerName: worker.name,
      speakerRole: worker.teamRole || "worker",
      content: answer,
    });
    broadcast("team-message", { teamId: worker.teamId, ...posted });
  }
  await deliverTeammateReply(chiefId, worker, answer);
}

setTeamDispatch(dispatchToTeammate);
setTeamReply(deliverTeammateReply);
setStopBot((id) => {
  stopTurn(id);
  deletedIds.add(id);
});
setEndTurn((id) => {
  stopTurn(id);
});

function stopTurn(botId: string): void {
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
  // Aborting the host loop only stops us reading; the desk keeps running the
  // work (a `sleep 300` outlived a stop that answered {ok:true,stopped:true}).
  store
    .getBot(botId)
    .then((b) => (b?.vm?.container ? vm.stopDeskWork(b as vm.DeskBot, { token: internalToken }) : null))
    .catch(() => {});
}

app.post("/api/bots/:id/control", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const on = Boolean(req.body?.on);
  if (on) {
    await holdHumanControl(bot.id, true);
    stopTurn(bot.id);
  } else {
    const released = releaseHumanControl(bot.id);
    // releaseHumanControl clears the in-memory Set; clear the persisted flag
    // too, or the next restart would re-arm Take control for a bot nobody is
    // driving and the bot would sit idle waiting to be released again.
    await holdHumanControl(bot.id, false);
    enqueueWake(boxHelpReleasedWake(released));
  }
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
    if (!on) live.awaitingUserSelection = false;
  });
  broadcast("message", { botId: bot.id, ...note });
  broadcast("control", { botId: bot.id, on });
  res.json({ ok: true, on });
});

app.post("/api/bots/:id/stop", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
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
  const live = await store.getBot(bot.id) as IndexBot | null;
  // The 404 at the top of this route already loaded this id.
  broadcast("bot", toClient(live!));
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

app.get("/api/spend-guard", (_req, res) => {
  res.json(spendGuard.snapshot());
});

app.post("/api/spend-guard/resume", (_req, res) => {
  spendGuard.resume();
  res.json(spendGuard.snapshot());
});

app.post("/api/bots/:id/messages", async (req, res) => {
  spendGuard.noteUserActivity();
  const bot = await store.getBot(req.params.id) as IndexBot | null;
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
    userSpoke(b);
    b.messages.push(userMsg);
  });
  broadcast("message", { botId: bot.id, ...userMsg });
  const live = inflightTurns.get(bot.id);
  const busy = busyIds.has(bot.id) && live;
  if (busy) {
    live.nudges.push(userMsg.content);
    talkWhileWorking(bot.id, userMsg.content).catch(() => {});
    res.json({ ok: true, queued: true });
    return;
  }
  res.json({ ok: true, queued: false });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, userMsg.content, false, images, { persistUser: false }));
});

app.post("/api/bots/:id/choice", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const messageId = String(req.body?.messageId || "");
  const choiceId = String(req.body?.choiceId || "");
  const custom = String(req.body?.custom || "").trim();
  const resolved = resolveChoice(bot.messages, { messageId, choiceId, custom });
  if (!resolved.ok) return res.status(400).json({ error: resolved.error });
  if (resolved.already) return res.json({ ok: true, already: true });
  // The card the model sent carries a `context` block that @sub8/choice does
  // not model — it is this server's own routing hint, read three lines down.
  const card = resolved.card as (ChoiceRow & { id?: string; context?: { intent?: string; name?: string } }) | null | undefined;
  const label = resolved.label as string;
  const selectedId = resolved.choiceId || choiceId || "custom";
  const shown = visibleChoiceReply(card, label);
  const secretPick = shown.secret;
  if (card) {
    card.pending = false;
    card.selected = { id: selectedId, label: shown.selectedLabel };
  }
  if (secretPick && custom && card?.secretTarget?.connector === "mcp" && card.secretTarget.field) {
    await mcpRemote.setServerAuth(card.secretTarget.field, custom).catch(() => {});
  } else if (secretPick && custom && (card?.secretTarget?.connector || "vault") === "vault") {
    const acc = await vault.upsertAccount({
      label: String(card?.content || "Secret").slice(0, 80),
      password: custom,
      notes: String(card?.secretTarget?.field || "secret"),
    });
    if (acc?.id) await vault.setAccountGrants(acc.id, [bot.id]).catch(() => {});
  }
  const describe = /i'?ll describe/i.test(label);
  const intent = card?.context?.intent;
  const name = card?.context?.name || "Worker";
  if (intent === "desk-resources") {
    const ctx = card?.context as { container?: string; ramMb?: number; pids?: number; action?: string } | undefined;
    let note = "Left as is.";
    if (selectedId === "increase" && ctx?.action === "raise-pids" && ctx?.container && ctx.pids) {
      const r = await vm.raiseDeskPids(ctx.container, ctx.pids);
      note = r.ok ? `Done — this computer now allows ${r.pids} processes.` : `Couldn't raise it: ${r.error}`;
    } else if (selectedId === "increase" && ctx?.container && ctx.ramMb) {
      const r = await vm.raiseDeskResources(ctx.container, ctx.ramMb);
      note = r.ok ? `Done — this computer now has ${r.memory} memory and a ${r.pids}-process limit.` : `Couldn't raise it: ${r.error}`;
      await store.patchBot(bot.id, (b) => {
        if (b.vm && ctx.ramMb) (b.vm as { ramMb?: number }).ramMb = ctx.ramMb;
      });
    } else if (ctx?.action === "ack") {
      note = "Waiting on the Docker Desktop memory raise.";
    }
    await store.patchBot(bot.id, (b) => {
      b.awaitingUserSelection = false;
      const c = (b.messages || []).find((m) => m.id === card?.id);
      if (c) (c as { pending?: boolean }).pending = false;
    });
    const out = { id: `a${Date.now()}dr`, role: "assistant", content: note, speakerId: bot.id, speakerName: bot.name, ts: Date.now() };
    await store.patchBot(bot.id, (b) => { b.messages = b.messages || []; b.messages.push(out as store.Message); });
    broadcast("message", { botId: bot.id, ...out });
    return res.json({ ok: true });
  }
  if (intent === "spend-guard") {
    if (selectedId === "pause") spendGuard.pauseByUser();
    else spendGuard.resume();
    await store.patchBot(bot.id, (b) => {
      b.awaitingUserSelection = false;
    });
    return res.json({ ok: true, paused: spendGuard.isPaused() });
  }
  if (intent === "create-teammate" && !describe) {
    const team = await teams.ensureTeamForBot(bot);
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
      // `card!`: `live` is only searched for when `card` is there.
      const live = card ? b.messages.find((m) => m.id === card.id) : null;
      if (live) {
        live.pending = false;
        live.selected = card!.selected;
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
    content: shown.userContent,
    ts: Date.now(),
  };
  await store.patchBot(bot.id, (b) => {
    b.messages = b.messages || [];
    // `card!`: same as the branch above — `live` is only searched for with one.
    const live = card ? b.messages.find((m) => m.id === card.id) : null;
    if (live) {
      live.pending = false;
      live.selected = card!.selected;
    } else if (card) {
      // A `ChoiceRow` spells `id` `unknown`; the stored row wants a string, and
      // `resolveChoice` only ever hands back a card it found by its id.
      b.messages.push({ ...card, pending: false, selected: card.selected } as store.Message);
    }
    b.messages.push(userMsg);
    b.awaitingUserSelection = false;
  });
  broadcast("message", { botId: bot.id, ...userMsg });
  enqueueTurn(bot.id, () =>
    runUserTurn(
      bot.id,
      shown.nextTurn,
      false,
      [],
      { persistUser: false },
    ),
  );
  res.json({ ok: true, queued: busyIds.has(bot.id) });
});

app.post("/api/bots/:id/teach", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  const name = String(req.body?.name || "Taught task").trim();
  const frames = Array.isArray(req.body?.frames) ? req.body.frames.filter((x) => typeof x === "string").slice(0, 16) : [];
  const text = `I just demonstrated a task called "${name}". The screenshots are in order. Learn the steps, then upsert_routine so you can run this task again on your own. Name the routine clearly.`;
  res.json({ ok: true, name, frames: frames.length });
  enqueueTurn(bot.id, () => runUserTurn(bot.id, text, false, frames));
});

app.get("/api/bots/:id/routines", async (req, res) => {
  const bot = await store.getBot(req.params.id) as IndexBot | null;
  if (!bot) return res.status(404).json({ error: "not found" });
  res.json(bot.routines || []);
});

app.post("/api/bots/:id/routines", async (req, res) => {
  const body = req.body || {};
  const minutes = Number(body.interval_minutes ?? body.intervalMinutes);
  const explicitInterval = Number.isFinite(minutes) && minutes > 0;
  const intervalProvided = Object.prototype.hasOwnProperty.call(body, "interval_minutes") || Object.prototype.hasOwnProperty.call(body, "intervalMinutes");
  const hasTriggers = Array.isArray(body.triggers) && body.triggers.length;
  // `hasTriggers` is the array length, so this is a truthy number or a boolean;
  // `isRejectedRoutineInstruction` only tests it for truth.
  if (typeof body.instruction === "string" && routines.isRejectedRoutineInstruction(body.instruction, { explicitInterval: explicitInterval || hasTriggers } as { explicitInterval?: boolean })) {
    return res.status(400).json({ error: "routine instruction is not a standing scheduled job" });
  }
  if (intervalProvided && !explicitInterval) {
    return res.status(400).json({ error: "invalid routine interval" });
  }
  if (!explicitInterval && !hasTriggers && body.schedule != null && !routines.normalizeSchedule(body.schedule)) {
    return res.status(400).json({ error: "invalid routine schedule" });
  }
  const settings = await store.loadSettings();
  let result: routines.UpsertResult | undefined;
  const live = await store.patchBot(req.params.id, (bot) => {
    // `RoutineSpec` spells `name`, `groupKey` and `intervalMs` without
    // `| undefined`, and `RoutineBot` spells `routines` without the store's
    // index signature. `upsertRoutine` reads each field with a truthiness or
    // `== null` test, so an explicit undefined and an absent key behave alike.
    result = routines.upsertRoutine(bot as routines.RoutineBot, {
      name: body.name,
      instruction: body.instruction,
      groupKey: body.group_key || body.groupKey,
      intervalMs: explicitInterval ? minutes * 60_000 : body.intervalMs,
      schedule: body.schedule,
      triggers: body.triggers,
      forceNew: body.force_new === true,
      solo: body.solo !== false,
      timeZone: resolveZone(settings as ContextSettings),
    } as routines.RoutineSpec);
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
      // `t!`: the `filter(Boolean)` on the line above dropped the nulls
      // `normalizeTrigger` answers for a trigger it could not read.
      r.triggers = body.triggers.map(routines.normalizeTrigger).filter(Boolean).map((t) => ({
        ...t,
        id: t!.id || randomUUID(),
      }));
      // `Routine` and `StoredRoutine` are the same row: @sub8/automations owns
      // the schedule fields, @sub8/store owns `runs` and the index signature.
      routines.syncLegacyFromTriggers(r as routines.Routine, Date.now(), resolveZone(settings as ContextSettings));
    } else if (Number.isFinite(minutes) && minutes > 0) {
      r.intervalMs = minutes * 60_000;
      delete r.schedule;
      delete r.nextRunAt;
      delete r.nextRunTimeZone;
      delete r.triggers;
    } else if (body.schedule != null) {
      const schedule = routines.normalizeSchedule(body.schedule);
      const previous = routines.normalizeSchedule(r.schedule);
      // `schedule!`: the route answered 400 at the top for a `body.schedule`
      // this same call could not normalise.
      const unchanged =
        previous &&
        previous.type === schedule!.type &&
        previous.hour === schedule!.hour &&
        previous.minute === schedule!.minute &&
        Number.isFinite(r.nextRunAt);
      // @sub8/automations' `DailySchedule` and @sub8/store's `StoredSchedule`
      // are the same three fields; the store models it open for older rows.
      r.schedule = schedule as store.StoredSchedule;
      delete r.intervalMs;
      delete r.triggers;
      const now = Date.now();
      r.nextRunAt = unchanged
        ? routines.calendarNextRunAt(r as routines.Routine, now, resolveZone(settings as ContextSettings))
        : routines.nextCalendarOccurrence(now, schedule, resolveZone(settings as ContextSettings));
      r.nextRunTimeZone = resolveZone(settings as ContextSettings);
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
  const bot = await store.getBot(req.params.id) as IndexBot | null;
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
  // `getBot` cannot miss here: the 404 four lines up already loaded this id,
  // and nothing between deletes a bot.
  broadcast("bot", toClient(await store.getBot(bot.id) as IndexBot));
  res.json({ ok: true });
});

async function talkWhileWorking(botId: string, text: string): Promise<void> {
  const bot = await store.getBot(botId) as IndexBot | null;
  const settings = await store.loadSettings();
  if (!bot) return;
  // Same two spellings as `runTurn` below: agent.mts names its own slice of a
  // bot row and of the settings record.
  // Only an API-model harness can answer in-line while the turn runs; otherwise
  // the running turn already has the message as a nudge and answers it itself.
  const content = await orchestratorReply({ bot, settings, userText: text } as Parameters<typeof orchestratorReply>[0]);
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

async function runUserTurn(botId: string, text: string, hidden: boolean, images: string[] = [], opts: TurnOptions = {}): Promise<void> {
  const turnStart = Date.now();
  const ac = new AbortController();
  turnAbort.set(botId, ac);
  busyIds.add(botId);
  const bag = { nudges: [] };
  inflightTurns.set(botId, bag);
  try {
    let bot = await store.getBot(botId) as IndexBot | null;
    if (!bot) return;
    const mapped = bot.vm?.container ? (vm.cachedMappedPort(bot.vm.container) || (await vm.detectMappedPort(bot.vm.container))) : null;
    const port = resolveStreamPort(bot.vm?.novncPort, mapped);
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
    const ready = await vm.waitForDesktop(bot as vm.Bot, {
      timeoutMs: 480_000,
      onLog: (m) => noteVm(botId, m),
      shouldAbort: async () => ac.signal.aborted || deletedIds.has(botId),
    });
    if (ac.signal.aborted) return;
    bot = await store.getBot(botId) as IndexBot | null;
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
      const live = await store.getBot(botId) as IndexBot | null;
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
    // A bot deleted while its computer was warming up comes back null here. The
    // cast this used to carry (`as IndexBot`, no `| null`) asserted that away,
    // so runTurn was handed null and threw on the first read — the surrounding
    // catch then tried to post an error into a chat whose bot no longer exists.
    // Every sibling refetch in this function guards; this one now does too, and
    // the `finally` below still clears turnAbort, inflightTurns and busyIds.
    const warmed = await store.getBot(botId) as IndexBot | null;
    if (!warmed) return;
    bot = warmed;
    const settings = await store.loadSettings();
    settings.__internalToken = internalToken;
    settings.__port = PORT;
    settings.__replyTo = opts.replyTo || null;
    settings.__didReply = false;
    // agent.mts's `AgentBot` and `AgentSettings` name its own slice of the same
    // two records; the assertion covers the whole argument so the shorthand
    // properties stay shorthand.
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
        broadcast(event, { botId, ...(data as Record<string, unknown>) });
        if (event === "harness-auth") {
          store.loadSettings().then((s) => collectHarnessStatus(s)).then((status) => broadcast("harness-status", status)).catch(() => {});
        }
        // Field-level persist. upsertBot(bot) here wrote the turn's whole
        // in-memory row on EVERY message event, silently undoing anything the
        // desk subprocess had just written (a routine, a reminder) — "Created
        // Reminder" in the log, nothing on the bot a second later.
        if (event === "routine" || event === "message") {
          return store.patchBot(botId, (b) => {
            b.messages = b.messages || [];
            const have = new Set(b.messages.map((m) => m.id));
            for (const m of bot.messages || []) if (m?.id && !have.has(m.id)) b.messages.push(m);
            if (event === "routine") b.routines = bot.routines || [];
            b.awaitingUserSelection = bot.awaitingUserSelection;
          }).then(() => undefined);
        }
      },
    } as RunTurnOptions);
    if (opts.replyTo && !settings.__didReply && !notifiedThisTurn.has(notifyKey(botId, opts.replyTo))) {
      const latest = await store.getBot(botId) as IndexBot | null;
      // The worker's real answer reaches the lead and the channel; the
      // job-step ping is only the fallback when it produced no reply at all.
      const ping = await shortStepPing(latest);
      await deliverWorkerAnswer(opts.replyTo, latest, ping, turnStart);
    }
    {
      const latest = await store.getBot(botId) as IndexBot | null;
      // Only THIS turn's final message counts (ts >= turnStart): a turn that
      // ended in a choices card or tool call must not fall through to an older
      // turn's text and deliver that as the answer.
      // ...and the lead's OWN row: a teammate's report is stored in the lead's
      // thread as role "assistant" with the teammate as speaker, and a report
      // nudged into an in-flight turn was being delivered as the lead's reply.
      const last = [...(latest?.messages || [])].reverse().find((m) => m.role === "assistant" && String(m.content || "").trim() && m.kind !== "choices" && Number(m.ts || 0) >= turnStart && (!m.speakerId || m.speakerId === latest?.id));
      if (latest?.teamRole === "chief") {
        if (last) await finalizeChiefJob(latest);
        // Every turn, including a report turn: the lead's final message is its
        // answer (a combined result it computed in text would otherwise be
        // lost). Nothing to add means it writes nothing — see chiefReportLlm.
        if (last) await deliverLeadAnswer(latest, last, turnStart);
      }
    }
    // Don't let a long turn resurrect routines/vm state deleted while it ran.
    const latest = await store.getBot(botId) as IndexBot | null;
    if (latest) {
      bot.routines = latest.routines || [];
      bot.vm = latest.vm;
    } else if (!Array.isArray(bot.routines)) {
      bot.routines = [];
    }
    await store.upsertBot(bot);
    broadcast("bot", toClient(bot));
  } catch (err) {
    const aborted = ac.signal.aborted || /abort|stopped/i.test((err as Error).message || "");
    if (!aborted) {
      broadcast("error", { botId, error: (err as Error).message });
      const b = await store.getBot(botId) as IndexBot | null;
      if (b) {
        // Every other messages.push in this file guards first; this one relied on
        // loadBots normalising messages to []. Inside a catch that is the wrong
        // place to lean on a distant invariant — a throw here would replace the
        // real error with a TypeError about `messages`.
        b.messages = b.messages || [];
        b.messages.push({
          id: `e${Date.now()}`,
          role: "assistant",
          content: looksLikeAuthFailure((err as Error).message)
            ? rewriteHarnessOutput(b.harness?.provider || "claude", (err as Error).message)
            : `That failed: ${(err as Error).message}`,
          ts: Date.now(),
        });
        await store.upsertBot(b);
        broadcast("bot", toClient(b));
      }
    }
  } finally {
    // Cleared HERE, not after the awaited runTurn where it used to sit. The key
    // is added unconditionally when a worker messages its chief mid-turn, so a
    // turn that threw -- a harness error, or the user pressing Stop -- jumped to
    // the catch and left it behind. The next dispatch to that worker then saw
    // the stale key, suppressed the forced step-ping, and the chief waited
    // indefinitely for a report that would never come.
    notifiedThisTurn.delete(notifyKey(botId, opts.replyTo));
    const leftover = bag.nudges.splice(0);
    if (turnAbort.get(botId) === ac) turnAbort.delete(botId);
    inflightTurns.delete(botId);
    busyIds.delete(botId);
    const live = await store.getBot(botId) as IndexBot | null;
    if (live) broadcast("bot", toClient(live));
    if (leftover.length && !ac.signal.aborted) {
      enqueueTurn(botId, () => runUserTurn(botId, leftover.join("\n"), false, [], { persistUser: false }));
    }
  }
}

async function tickRoutines() {
  const bots = await store.loadBots() as IndexBot[];
  const now = Date.now();
  const settings = await store.loadSettings();
  const timeZone = resolveZone(settings as ContextSettings);
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
      // Same row, two owners: @sub8/automations spells the schedule fields,
      // @sub8/store spells `runs` and keeps the index signature.
      routines.hydrateRoutine(r as routines.Routine, now, timeZone);
      if (Array.isArray(r.triggers) && r.triggers.length) {
        for (const t of r.triggers) {
          // `t.nextRunAt!`: `Number.isFinite` on the left is what proves it a
          // number, and `||` never reaches the right side otherwise.
          if (!Number.isFinite(t.nextRunAt) || t.nextRunAt! <= 0) {
            t.nextRunAt = routines.nextTriggerOccurrence(t, now, timeZone);
          }
        }
        continue;
      }
      if (!routines.isCalendarRoutine(r as routines.Routine)) continue;
      const next = routines.calendarNextRunAt(r as routines.Routine, now, timeZone);
      if (Number.isFinite(next) && next !== r.nextRunAt) {
        r.nextRunAt = next;
        r.nextRunTimeZone = timeZone;
      }
    }
    const dirty = (bot.routines || []).some((r, i) => {
      // `snapshot` was built from this same array one loop up, so index `i` is
      // always in it; only noUncheckedIndexedAccess cannot see that.
      const prev = snapshot[i]!;
      return prev.intervalMs !== r.intervalMs || JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule) || prev.nextRunAt !== r.nextRunAt || prev.triggers !== JSON.stringify(r.triggers || []);
    });
    if (dirty) {
      bot =
        ((await store.patchBot(bot.id, (live) => {
          for (const r of live.routines || []) {
            routines.hydrateRoutine(r as routines.Routine, now, timeZone);
            if (Array.isArray(r.triggers) && r.triggers.length) {
              for (const t of r.triggers) {
                if (!Number.isFinite(t.nextRunAt) || t.nextRunAt <= 0) {
                  t.nextRunAt = routines.nextTriggerOccurrence(t, now, timeZone);
                }
              }
              continue;
            }
            if (!routines.isCalendarRoutine(r as routines.Routine)) continue;
            const next = routines.calendarNextRunAt(r as routines.Routine, now, timeZone);
            if (Number.isFinite(next) && next !== r.nextRunAt) {
              r.nextRunAt = next;
              r.nextRunTimeZone = timeZone;
              r.updatedAt = now;
            }
          }
        })) as IndexBot | null) || bot;
    }
    const due = routines.dueRoutines(bot as routines.RoutineBot, now, { timeZone });
    if (!due.length) continue;
    const packs = routines.packDue(due);
    for (const pack of packs) {
      const accepted: store.StoredRoutine[] = [];
      await store.patchBot(bot.id, (live) => {
        const currentDue = new Map(routines.dueRoutines(live as routines.RoutineBot, now, { timeZone }).map((r) => [r.id, r as store.StoredRoutine]));
        for (const id of pack.ids) {
          const r = currentDue.get(id);
          if (r) {
            r.lastRunAt = now;
            if (Array.isArray(r.triggers) && r.triggers.length) {
              for (const t of r.triggers) {
                if (routines.triggerDue(t, now, timeZone)) routines.advanceTrigger(t, now, timeZone);
              }
              // A one-off reminder that just fired is done — show it as such.
              if (r.triggers.every((t) => t.kind === "once" && !t.nextRunAt)) r.enabled = false;
            } else if (routines.isCalendarRoutine(r as routines.Routine)) routines.advanceCalendarRoutine(r as routines.Routine, now, timeZone);
            r.updatedAt = now;
            r.runs = [...(Array.isArray(r.runs) ? r.runs : []), { ts: now }].slice(-24);
            accepted.push(r);
          }
        }
      });
      if (!accepted.length) continue;
      const live = ((await store.getBot(bot.id)) as IndexBot | null) || bot;
      // `accepted[0]!`: the `continue` two lines up is what proves it is there.
      const prompt = await memory.routineFirePrompt(live as memory.MemoryBot, accepted as memory.MemoryRoutine[], now, timeZone).catch(
        () =>
          `Standing routine "${accepted[0]!.name}" is due (repeating job, run ${(accepted[0]!.runs || []).length || 1}). Continue from previous progress. Do not start over.\n${accepted[0]!.instruction || ""}`,
      );
      const guard = spendGuard.decide(now);
      if (guard.action === "skip-paused") continue;
      if (guard.action === "nudge") {
        await postSpendNudge(live, guard.reason).catch((e) => console.error("spend nudge", e));
        continue;
      }
      spendGuard.noteFire(now);
      enqueueTurn(bot.id, () => runUserTurn(bot.id, prompt, true));
    }
  }
}

/** The "you've been away — keep routines running?" card, posted once when the
 * guard pauses automations. The user's next message auto-resumes; the buttons
 * let them resume now or stay paused. */
async function postSpendNudge(bot: IndexBot, reason: string): Promise<void> {
  const card = {
    id: `sg${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    role: "assistant",
    kind: "choices",
    content: `I paused my standing routines — ${reason}. Keep them running?`,
    hint: "They resume when you're back. Pause all keeps them off until you resume.",
    choices: [
      { id: "keep", label: "Keep running" },
      { id: "pause", label: "Pause all" },
    ],
    pending: true,
    context: { intent: "spend-guard" },
    speakerId: bot.id,
    speakerName: bot.name,
    ts: Date.now(),
  };
  await store.patchBot(bot.id, (b) => {
    b.messages = b.messages || [];
    if (!(b.messages as { id?: string }[]).some((m) => m.id === card.id)) (b.messages as unknown[]).push(card);
  });
  broadcast("message", { botId: bot.id, ...card });
}

/**
 * The user's local desk-memory choice ("4g", "8g"…) applies to NEW containers
 * via the same env deskMemory() already reads. Set at boot and on settings save.
 */
function applyDeskMemorySetting(settings: { deskMemory?: unknown } | null | undefined): void {
  const v = String(settings?.deskMemory || "").trim().toLowerCase();
  if (/^[0-9]{1,2}g$/.test(v)) process.env.LOCALBOT_MEMORY = v;
}
store.loadSettings().then((s0) => applyDeskMemorySetting(s0 as { deskMemory?: unknown })).catch(() => {});

/**
 * Resource pressure watcher. The desk hit its pids ceiling mid-session and the
 * failure surfaced as nonsense ("I can't install screenshot tools") — nothing
 * knew the ceiling existed. Every minute: for each running local desk, read its
 * cgroup usage; near a limit, offer the user an upgrade as a choice card from
 * that desk's lead. When Docker Desktop's VM itself is the ceiling (7.7 GB of a
 * 128 GB Mac), say exactly that and where to raise it — that one is a human
 * action. One card per container per hour; acting on it is the intent handler.
 */
const deskPressureCardAt = new Map<string, number>();
setInterval(async () => {
  try {
    const bots = await store.loadBots() as IndexBot[];
    const byContainer = new Map<string, IndexBot[]>();
    for (const b of bots) {
      const c = b.vm?.container;
      if (c && b.vm?.status === "running") (byContainer.get(c) || byContainer.set(c, []).get(c)!).push(b);
    }
    for (const [container, mates] of byContainer) {
      const last = deskPressureCardAt.get(container) || 0;
      if (Date.now() - last < 60 * 60 * 1000) continue;
      const st = await vm.deskResourceStatus(container).catch(() => null);
      if (!st || !st.pressure) continue;
      const owner = mates.find((b) => b.teamRole === "chief") || mates[0]!;
      if (owner.awaitingUserSelection) continue;
      deskPressureCardAt.set(container, Date.now());
      const nextRamMb = Math.min(16384, Math.max(4096, (st.memMaxMb || 2048) * 2));
      const nextPids = Math.min(8192, Math.max(1024, (st.pidsMax || 768) * 2));
      const vmCeiling = st.vmTotalMb > 0 && nextRamMb > st.vmTotalMb * 0.8;
      const facts = `memory ${st.memUsedMb}/${st.memMaxMb || "∞"} MiB, processes ${st.pids}/${st.pidsMax || "∞"}`;
      // Pids pressure is cheap to fix (raise the process limit, live, no VM
      // impact). Only MEMORY pressure can hit the Docker Desktop VM ceiling.
      const card = st.pressure === "pids"
        ? {
            id: `dr${Date.now()}`,
            role: "assistant",
            kind: "choices",
            content: `My computer is running low on process slots (${facts}). Give it more?`,
            hint: `Raises the process limit to ${nextPids}, live — nothing restarts, no extra memory needed.`,
            choices: [
              { id: "increase", label: `Raise to ${nextPids} processes` },
              { id: "keep", label: "Keep as is" },
            ],
            pending: true,
            context: { intent: "desk-resources", container, pids: nextPids, action: "raise-pids" },
            speakerId: owner.id,
            speakerName: owner.name,
            ts: Date.now(),
          }
        : vmCeiling
        ? {
            id: `dr${Date.now()}`,
            role: "assistant",
            kind: "choices",
            content: `My computer is near its limits (${facts}) — and the real ceiling is Docker Desktop itself: it only gives Docker ${(st.vmTotalMb / 1024).toFixed(1)} GB of this Mac's ${(st.hostTotalMb / 1024).toFixed(0)} GB.`,
            hint: "Raise it in Docker Desktop → Settings → Resources → Memory (16 GB is comfortable), then Apply & Restart. I can't change that setting myself.",
            choices: [{ id: "ack", label: "Got it" }],
            pending: true,
            context: { intent: "desk-resources", container, action: "ack" },
            speakerId: owner.id,
            speakerName: owner.name,
            ts: Date.now(),
          }
        : {
            id: `dr${Date.now()}`,
            role: "assistant",
            kind: "choices",
            content: `My computer is near its limits (${facts}). Give it more room?`,
            hint: `Raises this computer to ${(nextRamMb / 1024).toFixed(0)} GB memory and a matching process limit, live — nothing restarts.`,
            choices: [
              { id: "increase", label: `Increase to ${(nextRamMb / 1024).toFixed(0)} GB` },
              { id: "keep", label: "Keep as is" },
            ],
            pending: true,
            context: { intent: "desk-resources", container, ramMb: nextRamMb, action: "raise" },
            speakerId: owner.id,
            speakerName: owner.name,
            ts: Date.now(),
          };
      await store.patchBot(owner.id, (b) => {
        b.messages = b.messages || [];
        if (!(b.messages as { id?: string }[]).some((m) => m.id === card.id)) (b.messages as unknown[]).push(card);
        b.awaitingUserSelection = true;
      });
      broadcast("message", { botId: owner.id, ...card });
      if (owner.teamId) {
        const posted = await teams.appendMessage(owner.teamId, { ...(card as unknown as Record<string, unknown>), speakerRole: "chief" });
        broadcast("team-message", { teamId: owner.teamId, ...posted });
      }
    }
  } catch {
    /* next tick */
  }
}, 60_000);

setInterval(() => tickRoutines().catch((e) => console.error("routines", e)), 15_000);
setInterval(() => drainLeftoverWakes().catch((e) => console.error("wakes", e)), 5_000);

/**
 * Put a wake back in the durable ledger after the turn it was taken for was
 * discarded. `requeueWake`, NOT `enqueueWake`: the latter notifies subscribers
 * synchronously, which would start a turn at the NEW epoch -- the very turn
 * the guard just discarded, so a Stop would not stop it. drainLeftoverWakes
 * picks it up 5s later, once the bot is idle.
 */
function requeueTakenWake(wake: Wake | null | undefined): void {
  if (!wake) return;
  try {
    requeueWake(wake);
  } catch {
    /* unknown type: it could not have been drained anyway */
  }
}

function fireDurableWake(wake: Wake | null | undefined): void {
  if (!wake?.botId) return;
  enqueueTurn(
    wake.botId,
    () => runUserTurn(wake.botId, turnPromptForWake(wake), true),
    // takeWakeOfType/takeWakeById splice the wake out of wakes.json and persist
    // BEFORE the turn exists, so a turn the epoch guard then discards took the
    // message with it -- and nothing retried, because the ledger no longer had
    // it. Reachable whenever a bot has two wakes pending: drainLeftoverWakes
    // takes one per type in a single pass and queues both at the same epoch, so
    // the first ending on a card (ask_user, a widget) bumps the epoch and
    // silently eats the second. Put it back for the next drain.
    () => {
      // requeueWake, NOT enqueueWake: enqueueWake notifies subscribers
      // synchronously, and the durable-wake subscriber would take it straight
      // back and start a turn at the NEW epoch -- running the very turn the
      // guard just discarded, so a Stop would not stop it. Silent re-queue
      // leaves it for drainLeftoverWakes, 5s later, once the bot is idle.
      try {
        requeueWake(wake);
      } catch {
        /* unknown type: it could not have been drained anyway */
      }
    },
  );
}

subscribeDurableWakes((wake) => {
  if (!AUTO_DRAIN_WAKE_TYPES.includes(wake?.type)) return;
  if (busyIds.has(wake.botId) || isHumanControl(wake.botId)) return;
  const taken = takeWakeById(wake.botId, wake.id);
  if (taken) fireDurableWake(taken);
});

subagents.subscribeWakes((wake) => {
  const parentId = wake?.parentBotId;
  if (!parentId) return;
  const taken = takeWakeOfType(parentId, "subagent-complete");
  enqueueTurn(
    parentId,
    () => runUserTurn(parentId, turnPromptForWake({ type: "subagent-complete", payload: { id: wake.id, result: wake.result } }), true),
    // The same ledger race fireDurableWake documents, which these two
    // listeners never got: the take above spliced the wake out of wakes.json
    // and persisted it BEFORE this turn existed, so a turn the epoch guard
    // discards (parent ended on a card, or the user pressed Stop) takes the
    // only record that the task finished with it. Put it back for the drain.
    () => requeueTakenWake(taken),
  );
});

codeAgent.subscribeWakes((wake) => {
  const parentId = wake?.botId;
  if (!parentId) return;
  const taken = takeWakeOfType(parentId, "code-agent-complete");
  // `WakePayload` spells `prUrl` `?: string`; a code agent that opened no PR has
  // none, which is the absent key that spelling means.
  enqueueTurn(
    parentId,
    () =>
      runUserTurn(parentId, turnPromptForWake({ type: "code-agent-complete", payload: { id: wake.id, prUrl: wake.prUrl } as WakePayload }), true),
    () => requeueTakenWake(taken),
  );
});

async function drainLeftoverWakes() {
  const bots = await store.loadBots() as IndexBot[];
  const kinds = [...AUTO_DRAIN_WAKE_TYPES, "code-agent-complete", "subagent-complete"];
  for (const bot of bots) {
    if (busyIds.has(bot.id) || isHumanControl(bot.id)) continue;
    for (const type of kinds) {
      const wake = takeWakeOfType(bot.id, type);
      if (wake) fireDurableWake(wake);
    }
  }
}

const provisioning = new Set<string>();

function noteVm(id: string, hint: string): void {
  broadcast("log", { botId: id, m: hint });
}

async function provision(id: string): Promise<void> {
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
    const row = await computers.ensureComputerForBot(bot as computers.ComputerBot);
    // `row!` here and below: `ensureComputerForBot` answers null for a null bot,
    // and `provision` returned already if `patchBot` could not find this one.
    const ready = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, computerId: row!.id, container: row!.container, volume: row!.volume, detached: false };
    });
    if (ready) {
      // `provision` set `live.vm` two statements up, so the row it just read
      // back carries one.
      Object.assign(bot.vm!, ready.vm);
      broadcast("bot", toClient(ready));
    }
    const info = await vm.startVm(
      bot as vm.Bot,
      (m) => noteVm(id, m),
      async () => deletedIds.has(id) || !(await store.getBot(id)),
    );
    const live = await store.patchBot(id, (b) => {
      b.vm = { ...b.vm, ...info, computerId: row!.id, error: null, hint: "" };
    });
    await computers.saveComputer({
      ...row,
      status: info.status || "running",
      novncPort: info.novncPort,
      lastBotId: id,
      pausedByQuit: false,
    });
    if (live) {
      vault.pushListToBot(live as vault.VaultBot).catch(() => {});
      if (live.teamId) {
        const team = await teams.getTeam(live.teamId);
        const all = await store.loadBots() as IndexBot[];
        const mates = teams.membersOf(team, all);
        // `Team.chiefId` is `string | null`; `applyTeamDisplays` reads it with a
        // truthiness test, which is the absent key its `?: string` means.
        const assigned = vm.applyTeamDisplays(team as { memberIds?: readonly string[]; chiefId?: string }, mates as vm.Bot[], info.novncPort);
        await vm.bindDisplayStreams(info.container, assigned);
        await vm.scaleDeskMemory(info.container, assigned.length).catch(() => {});
        for (const m of assigned) {
          await store.upsertBot(m as IndexBot);
          if (vm.displayNum(m) > 1) await vm.ensureBotDisplay(m).catch((err) => noteVm(id, String(err.message || err)));
          broadcast("bot", toClient(m as IndexBot));
        }
      } else {
        broadcast("bot", toClient(live));
      }
      vm.screenshotContainer(info.container, vm.computerPreviewPath(row!.id)).catch(() => {});
    }
  } catch (err) {
    const transient = /app install|Unable to fetch|apt|wget|PackageKit|warming|not become/i.test((err as Error).message || "");
    const live = await store.patchBot(id, (b) => {
      b.vm = {
        ...b.vm,
        status: transient ? "starting" : "error",
        error: transient ? null : (err as Error).message,
        hint: transient ? "Still setting up the computer…" : (err as Error).message,
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

/**
 * Last resort for a route that threw or rejected. MUST stay after every route.
 *
 * Without it, express hands the error to finalhandler, which returns
 * `err.stack` in the response body for any NODE_ENV other than "production" --
 * and NODE_ENV is never set anywhere in this repo. So an unhandled throw
 * answered with the full stack, disclosing the install path and the user's home
 * directory. `POST /api/teams` with `{"members":[null]}` is one way in.
 *
 * The stack still goes to the terminal, where it is useful; only the response
 * is reduced to the message.
 */
// The 4th parameter is not decorative: express identifies an error handler by
// arity, so dropping it silently turns this back into a normal middleware that
// never runs.
const apiErrorHandler: ErrorMiddleware = (err, req, res, _next) => {
  console.error(`[api] ${req.method} ${req.url} failed:`, err?.stack || err);
  if (res.headersSent) return;
  // Honour the status the error carries. finalhandler did this before there was
  // a handler here, so hardcoding 500 turned body-parser's own answers into
  // 500s: a malformed JSON body is `SyntaxError status=400
  // type=entity.parse.failed`, and a body over express.json's 8mb limit is
  // `PayloadTooLargeError status=413`. Both are the client's fault and should
  // say so.
  const carried = Number((err as { status?: number; statusCode?: number })?.status)
    || Number((err as { statusCode?: number })?.statusCode);
  const status = Number.isInteger(carried) && carried >= 400 && carried <= 599 ? carried : 500;
  res.status(status).json({ ok: false, error: String(err?.message || "server error") });
};
app.use(apiErrorHandler);

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
  const [bots, list] = await Promise.all([store.loadBots() as Promise<IndexBot[]>, vm.listLocalbotStates()]);
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
    if (st === "error" && name && liveBox?.running) {
      const live = await store.patchBot(bot.id, (b) => {
        b.vm = { ...b.vm, status: "running", error: null, hint: "" };
      });
      if (live) broadcast("bot", toClient(live));
      continue;
    }
    if (st === "running" || st === "paused" || st === "exited" || st === "stopped") continue;
    provision(bot.id).catch((err) => console.error("ensure desktop", bot.id, err));
  }
  return dock;
}

async function collectRecoverHints() {
  const [teamRows, comps] = await Promise.all([teams.listTeams(), computers.listComputers()]);
  const hints = new Map<string, RecoverHint>();
  const take = (id: string): RecoverHint => {
    if (!hints.has(id)) hints.set(id, { id });
    // `set` on the line above is what makes this `get` a hit.
    return hints.get(id)!;
  };
  for (const c of comps) {
    if (!c.lastBotId) continue;
    if (c.status === "missing") continue;
    const h = take(c.lastBotId);
    h.vm = {
      status: c.status === "running" ? "running" : c.status || "idle",
      container: c.container || null,
      volume: c.volume || null,
      novncPort: c.novncPort || null,
      computerId: c.id,
      detached: false,
      hint: "",
    };
    const desk = String(c.name || "");
    if (desk.endsWith("'s desk") && !h.name) h.name = desk.slice(0, -"'s desk".length);
  }
  for (const t of teamRows) {
    const msgs = await teams.loadMessages(t.id);
    const names = new Map();
    for (const m of msgs || []) {
      if (m.speakerId && m.speakerName) names.set(m.speakerId, m.speakerName);
    }
    for (const id of t.memberIds || []) {
      const h = take(id);
      h.teamId = t.id;
      h.teamRole = id === t.chiefId ? "chief" : "worker";
      if (names.get(id)) h.name = names.get(id);
    }
    const withVm = (t.memberIds || []).map((id) => hints.get(id)).find((x) => x?.vm?.container);
    if (withVm?.vm) {
      for (const id of t.memberIds || []) {
        const h = take(id);
        if (!h.vm?.container) h.vm = { ...withVm.vm };
      }
    }
  }
  const live = await store.loadBots() as IndexBot[];
  const byTeam = new Map();
  for (const b of live) {
    if (b.teamId && b.harness) byTeam.set(b.teamId, b.harness);
  }
  for (const h of hints.values()) {
    if (!h.harness && h.teamId && byTeam.get(h.teamId)) h.harness = byTeam.get(h.teamId);
    if (!h.harness) h.harness = { provider: "claude", model: "default" };
  }
  return [...hints.values()];
}

async function restoreDeskAutomations(bot: IndexBot) {
  const box = bot?.vm?.container;
  if (!box || (bot.routines || []).length) return bot;
  const listed = await vm.docker(
    ["exec", "-u", "abc", box, "bash", "-lc", `find /config/agent-data/agents/${bot.id}/automations -name automation.json 2>/dev/null`],
    { timeout: 15_000 },
  );
  const files = String(listed.out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith("automation.json"));
  if (!files.length) return bot;
  const rows: RestoredRoutine[] = [];
  for (const file of files) {
    const got = await vm.docker(["exec", "-u", "abc", box, "cat", file], { timeout: 15_000 });
    if (!got.ok) continue;
    try {
      const auto = JSON.parse(got.out);
      const parsed = routines.parseSchedule(auto.cadence || auto.name || "");
      rows.push({
        id: auto.id || undefined,
        name: auto.name || "Routine",
        instruction: auto.instruction || "",
        intervalMs: parsed?.intervalMs,
        schedule: parsed?.schedule,
        enabled: false,
        groupKey: auto.groupKey || routines.groupKey(auto.instruction || auto.name || ""),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch {
      /* skip one file */
    }
  }
  if (!rows.length) return bot;
  return store.patchBot(bot.id, (b) => {
    b.routines = rows.map((r) => ({
      id: r.id || randomUUID(),
      name: r.name,
      instruction: r.instruction,
      intervalMs: r.intervalMs || 5 * 60_000,
      schedule: r.schedule || undefined,
      enabled: r.enabled !== false,
      groupKey: r.groupKey || "general",
      createdAt: r.createdAt || Date.now(),
      updatedAt: Date.now(),
      // Same three fields either way: @sub8/automations names the schedule,
      // @sub8/store keeps it open for the rows older builds wrote.
    } as store.StoredRoutine));
  });
}

const httpServer = app.listen(PORT, "127.0.0.1", async () => {
  hostCli.warmHostPlugins();
  const migrated = store.migrateUserData(dataDir, { extraSources: [path.join(appRoot, "data")] });
  if (migrated.copied.length || migrated.clonedFrom) {
    console.log(
      "migrated user data",
      migrated.clonedFrom ? `cloned ${migrated.clonedFrom}` : "",
      migrated.copied.length ? `copied ${migrated.copied.join(", ")}` : "",
    );
  }
  console.log(`Sub8 http://127.0.0.1:${PORT}`);
  try {
    const hints = await collectRecoverHints();
    const recovered = await store.recoverMissingBots(hints);
    if (recovered.length) {
      console.log("recovered bots", recovered.map((b) => `${b.name} ${b.id.slice(0, 8)}`).join(", "));
      for (const row of recovered) {
        try {
          await restoreDeskAutomations(row as IndexBot);
        } catch (err) {
          console.error("restore automations", row.id, (err as Error).message || err);
        }
      }
      const all = await store.loadBots() as IndexBot[];
      for (const t of await teams.listTeams()) {
        const mates = teams.membersOf(t, all);
        if (mates.length < 2) continue;
        const chief = mates.find((m) => m.id === t.chiefId) || mates[0];
        vm.applyTeamDisplays(t as { memberIds?: readonly string[]; chiefId?: string }, mates as vm.Bot[], chief?.vm?.novncPort || null);
        for (const m of mates) await store.upsertBot(m);
      }
      broadcast("bots", all.map(toClient));
      broadcast("teams", await publicTeams());
    }
    // Before anything can drive a desk: re-arm Take control for bots that were
    // being driven when the host stopped. drainLeftoverWakes runs 5s from now
    // and tickRoutines 15s from now, and both consult isHumanControl.
    const heldAgain = await restoreHumanControl();
    if (heldAgain) console.log(`take control restored for ${heldAgain} bot(s)`);

    const bots = await store.loadBots() as IndexBot[];
    // `configVolume` reads `bot.id` and `bot.vm?.volume`; vm.mts and
    // computers.mts name their own slice of that same row.
    const mig = await computers.migrateFromBots(bots as computers.ComputerBot[], {
      containerName: vm.containerName,
      configVolume: vm.configVolume as (bot: computers.ComputerBot) => string,
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
    const live = await store.loadBots() as IndexBot[];
    for (const b of live) {
      if (!b?.vm?.container) continue;
      await vm.writeDeskMcpConfig(b.vm.container, {
        botId: b.id,
        display: b.vm.display,
        internalToken,
      }).catch(() => {});
    }
    vm.warmLocalDesks({
      bots: live as vm.Bot[],
      upsertBot: (b) => store.upsertBot(b as IndexBot),
      onLog: (m) => console.log(m),
    }).catch((err) => console.error("warmLocalDesks", err));
    drainLeftoverWakes().catch((err) => console.error("completion-wakes", err));
  } catch (err) {
    console.error("startup computers", err);
  }
  ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  setInterval(() => {
    ensureDesktops().catch((err) => console.error("ensureDesktops", err));
  }, 12_000);
  vault.startVaultBridge(() => store.loadBots() as Promise<vault.VaultDeskBot[]>);
});
httpServer.requestTimeout = 900_000;
httpServer.headersTimeout = 900_000;
httpServer.timeout = 900_000;
httpServer.on("error", (err) => {
  console.error(`listen ${PORT}`, err.message || err);
  process.exit(1);
});
