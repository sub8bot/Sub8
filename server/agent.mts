import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import * as vm from "./vm.mjs";
import * as routines from "@sub8/automations";
import { appRoot } from "./paths.mjs";
import { isHumanControl } from "@sub8/control";
import * as vault from "./vault.mjs";
import * as hostCli from "./host-cli.mjs";
import { detectLocalHarnesses, localSpec } from "./local-llm.mjs";
import * as ctx from "./context.mjs";
import * as memory from "./memory.mjs";
import * as teams from "./teams.mjs";
import * as store from "@sub8/store";
import { looksLikeAuthFailure, rewriteHarnessOutput } from "@sub8/harness-auth";
import { TOOLS } from "./tools-catalog.mjs";
export { TOOLS };
import { handleUpdateState } from "./update-state.mjs";
import { requestBoxHelp } from "@sub8/control";
import { readFile } from "./read-file.mjs";
import { webFetch } from "@sub8/web-fetch";
import * as channels from "@sub8/store/channels";
import { syncChannelDesk } from "./channel-desk.mjs";
import * as subagents from "./subagents.mjs";
import * as codeAgent from "./code-agent.mjs";
import { cardFromSendMessageArgs, AWAITING_BLOCKED } from "@sub8/choice";
import { reminderFor } from "@sub8/wakes";
import * as deskClient from "./desk-client.mjs";
import { ensureLocalHarness } from "./desk-harness/local.mjs";
import * as bgShell from "@sub8/shell-exec";
import { enqueueWake } from "@sub8/wakes";
import { sendToAgent, sendToAgentContent } from "./teammate.mjs";

bgShell.setOnCompleteWake((w) => {
  try {
    enqueueWake(w);
  } catch {
    /* tests without data dir */
  }
});
import * as mcpRemote from "@sub8/web-fetch/mcp-remote";

/* --- types ------------------------------------------------------------------
 *
 * Everything below is a type alias rather than an interface wherever the value
 * it describes is handed to @sub8/store, code-agent or teams: those model the
 * same JSON with an index signature, and only an object-literal type picks up
 * the implicit one that keeps it assignable to them.
 */

/**
 * The SSE pump the host hands a turn. Every call site here passes both
 * arguments; `payload` stays optional so this is exactly the callback shape
 * `hostCli.runHostCli` declares for the one it is given.
 */
type Emit = (event: string, payload?: unknown) => unknown;

/** How a chief hands work to a worker: `index.mjs` starts that Bot's turn. */
type DispatchTeammate = (botId: string, content: string, from: AgentBot) => unknown;

/**
 * How a worker's answer gets back to the chief. This file only holds the hook
 * for `index.mjs`; it never calls it, so the arguments stay unread.
 */
type DeliverReply = (...args: never[]) => unknown;

/** The stop / end-turn hooks the host owns, keyed by bot id. */
type BotIdFn = (botId: string) => unknown;

/** `settings.harness`, as this file reads it. */
type HarnessConfig = {
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
};

/**
 * As much of `data/settings.json` as this file reads, plus the two private
 * fields `index.mjs` hangs off the record before it starts a turn.
 */
export interface AgentSettings extends ctx.ContextSettings {
  harness?: HarnessConfig | undefined;
  __internalToken?: string | undefined;
  __port?: number | string | undefined;
  /** Set when this turn is a teammate reply, which never upserts a routine. */
  __replyTo?: unknown;
}

/**
 * A bot's computer, as this file reads and writes it. No optional field carries
 * an explicit `| undefined`: that would be a wider type than
 * `@sub8/automations`'s `RoutineBot.vm` and vm.mts's `VmInfo` spell, and this
 * record is handed to both.
 *
 * `container` and the two ports say `string` / `number` where a row off disk may
 * hold `null` — `store.newBot` writes `container: null`, and `startVm` answers a
 * null port. vm.mts's `VmInfo` already narrows `container` the same way, and
 * `desk-client`'s `HarnessBot` spells the ports `number | string | undefined`,
 * so widening either here would only move the mismatch. Every read below is a
 * truthiness check or an assignment, so a null behaves as the absence it is.
 */
type AgentBotVm = {
  container?: string;
  status?: string;
  display?: string;
  novncPort?: number | null;
  harnessPort?: number;
  hostHarnessPort?: number;
  deskUrl?: string;
  deskToken?: string;
  computerId?: string;
  setup?: vm.SetupProgress;
};

/** One chat row, as this file writes and reads it. */
type AgentMessage = {
  id: string;
  /** No explicit `| undefined` down to `hidden`: @sub8/wakes' `TurnMessage`, which
   *  `reminderFor` reads this array as, spells all six without it. */
  role?: string;
  kind?: string;
  content?: string;
  name?: string;
  hidden?: boolean;
  pending?: boolean;
  ts?: number;
  action?: string | undefined;
  summary?: string;
  toolCallId?: string;
  speakerId?: string | undefined;
  speakerName?: string | undefined;
  speakerRole?: string;
  toId?: string;
  toName?: string | undefined;
  [key: string]: unknown;
};

/**
 * One standing routine on the bot. Only the three fields this file writes are
 * named; @sub8/automations owns the rest and migrates rows written by older
 * builds lazily, which is why it models every one of them optional too.
 */
type AgentRoutine = {
  id: string;
  name?: string;
  enabled?: boolean;
  updatedAt?: number;
  [key: string]: unknown;
};

/**
 * As much of a bot record as this file touches. Wide on purpose: the same row
 * goes to @sub8/store, vm, memory, vault, teams, context, subagents and
 * code-agent, and each of those models its own slice of it.
 */
type AgentBot = {
  id: string;
  /** No explicit `| undefined` on any of these, for the same reason `AgentBotVm`
   *  carries none: @sub8/choice's `ChoiceSpeaker`, @sub8/automations' `RoutineBot`
   *  and vm.mts's `VmInfo` each spell their half of this record without it. */
  name?: string;
  description?: string;
  instructions?: string;
  color?: string;
  teamId?: string;
  teamRole?: string;
  harness?: HarnessConfig;
  vm?: AgentBotVm;
  messages: AgentMessage[];
  routines?: AgentRoutine[];
  grokSessionId?: string;
  harnessSessionId?: string;
  harnessSessionFresh?: boolean;
  awaitingUserSelection?: boolean;
  backgroundShells?: bgShell.ShellView[];
  [key: string]: unknown;
};

/**
 * A bot at a desk operation. `vm` is required for the same reason vault.mts's
 * `VaultDeskBot` requires it: these paths hand the record straight to the
 * container, and every one of them sits behind a `vm.status === "running"`
 * check that TypeScript cannot carry from the property onto the record.
 */
type AgentDeskBot = AgentBot & { vm: AgentBotVm };

/** One entry of `HARNESS_PROVIDERS`, as the Settings screen renders it. */
export interface HarnessProvider {
  id: string;
  label: string;
  kind: string;
}

/** The baseUrl + default model behind one hosted OpenAI-shaped provider. */
interface OpenAiApiDefault {
  baseUrl: string;
  model: string;
}

/**
 * One tool call off the wire. Every tool in the catalog is `type: "function"`,
 * and the local extractor below only ever builds function calls, so `function`
 * is always there.
 */
interface ToolCall {
  id: string;
  type?: string | undefined;
  function: { name: string; arguments?: string | undefined };
}

/**
 * The same call as it comes back off the wire, where `function` is optional:
 * the SDK's own union also models custom tool calls, which nothing in the
 * catalog can produce. The two reads in the turn loop assert past it, at the site.
 */
interface WireToolCall {
  id: string;
  type?: string | undefined;
  function?: { name: string; arguments?: string | undefined } | undefined;
}

/**
 * One part of a multi-part chat message. A single open shape rather than a
 * `text | image_url` union because the packers below filter these by `type` at
 * runtime and then read the field that implies, which no union survives.
 */
interface ContentPart {
  type: string;
  text?: string | undefined;
  image_url?: { url: string } | undefined;
}

/**
 * One row of the request transcript. Loose on purpose: this is the wire JSON
 * the OpenAI-shaped endpoints take, and `qwenSafeMessages` rewrites it.
 */
interface ChatMessage {
  role: string;
  content?: string | ContentPart[] | null | undefined;
  tool_call_id?: string | undefined;
  tool_calls?: WireToolCall[] | undefined;
}

/** One chat-completions request body, as the wire takes it. */
interface ChatRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  max_tokens?: number | null | undefined;
  reasoning_effort?: unknown;
}

/** The reply message. `reasoning_content` is what the local harnesses answer with. */
interface ChatResponseMessage {
  content?: string | null | undefined;
  reasoning_content?: string | undefined;
  reasoning?: string | undefined;
  tool_calls?: WireToolCall[] | undefined;
}

/** One chat-completions response, as far as this file reads it. */
interface ChatResponse {
  choices?: readonly { message?: ChatResponseMessage | undefined }[] | undefined;
  usage?: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined } | undefined;
}

/**
 * The single call this file makes on an OpenAI-shaped client, typed against the
 * wire JSON rather than the SDK's parameter unions: the tool catalog and the
 * history rows below are valid request bodies that those unions model more
 * narrowly, and local harnesses answer with `reasoning_content`, which the
 * SDK's response type does not carry. `new OpenAI(...)` satisfies this.
 */
interface ChatClient {
  chat: {
    completions: {
      create(body: ChatRequest, opts?: { signal: AbortSignal } | undefined): Promise<ChatResponse>;
    };
  };
}

/** A harness that runs outside this process: Claude / Codex / Hermes / Grok Build. */
interface CliHostClient {
  kind: "cli-host";
  provider: string;
  model: string;
  /** Never set by `resolveClient`; read only by the dead arm below. */
  command?: string | undefined;
  client?: undefined;
  baseUrl?: undefined;
}

/**
 * The dead arm. `pingHarness` and `runTurn` each still have a branch that tests
 * for `kind === "grok-build"`, but `resolveClient` has answered `"cli-host"` for
 * that provider since grok-build was routed through the CLI host, so neither
 * branch can run. The arm is spelled out rather than deleted because deleting it
 * would be a behaviour change, and folding it into `CliHostClient` would stop
 * both `kind` checks from narrowing. Reported, not changed.
 */
interface GrokBuildClient {
  kind: "grok-build";
  provider: string;
  model: string;
  command?: string | undefined;
  client?: undefined;
  baseUrl?: undefined;
}

/** A harness reached over an OpenAI-compatible HTTP API, local or hosted. */
interface OpenAiClient {
  kind: "openai";
  provider: string;
  model: string;
  baseUrl: string;
  client: ChatClient;
  command?: string | undefined;
}

type ResolvedClient = CliHostClient | GrokBuildClient | OpenAiClient;

/** Either harness that runs outside this process. */
type HostHarness = CliHostClient | GrokBuildClient;

/** What `pingHarness` answers the Settings screen with. */
export interface HarnessPing {
  ok: boolean;
  provider: string;
  kind: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  sample?: string | undefined;
  error?: string | null | undefined;
  log?: string | undefined;
  command?: string | undefined;
  container?: string | undefined;
}

/**
 * The desk-harness endpoint `deskClient.resolveHarness` picked. Declared here
 * rather than inferred because one of its two branches spreads whatever
 * `ensure` returned through the open `EnsuredHarness`, which widens `port` and
 * `token` to `unknown`.
 */
interface ResolvedEndpoint {
  url?: string | undefined;
  token?: string | undefined;
  via?: string | undefined;
  port?: number | undefined;
}

/**
 * A tool call's arguments, straight off the wire after `JSON.parse`. Every
 * field is a guess until the branch that reads it has checked it, which is what
 * the runtime does.
 */
interface ToolArgs {
  action?: string | undefined;
  text?: string | undefined;
  keys?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  x2?: number | undefined;
  y2?: number | undefined;
  dx?: number | undefined;
  dy?: number | undefined;
  ms?: number | undefined;
  ref?: unknown;
  url?: string | undefined;
  path?: string | undefined;
  content?: string | undefined;
  query?: string | undefined;
  command?: string | undefined;
  block_until_ms?: number | null | undefined;
  field?: string | undefined;
  account_id?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  instruction?: string | undefined;
  interval_minutes?: number | undefined;
  schedule?: unknown;
  group_key?: string | undefined;
  force_new?: unknown;
  force_replace?: unknown;
  solo?: unknown;
  replace?: unknown;
  enabled?: boolean | undefined;
  bot_id?: string | undefined;
  status?: string | undefined;
  label?: string | undefined;
  detail?: string | undefined;
  step_id?: string | undefined;
  title?: string | undefined;
  steps?: teams.JobStepSeed[] | undefined;
  question?: string | undefined;
  hint?: string | undefined;
  choices?: unknown;
  allow_custom?: unknown;
  all_workers?: unknown;
  job?: string | undefined;
  role?: string | undefined;
  harness?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  color?: string | undefined;
  instructions?: string | undefined;
  description?: string | undefined;
  member_ids?: string[] | undefined;
  memberIds?: string[] | undefined;
  channel_id?: string | undefined;
  channelId?: string | undefined;
  add_id?: string | undefined;
  remove_id?: string | undefined;
  type?: string | undefined;
  prompt?: string | undefined;
  message?: string | undefined;
  reason?: string | undefined;
  server_id?: string | undefined;
  tool?: string | undefined;
  arguments?: unknown;
  args?: unknown;
  headers?: Record<string, unknown> | undefined;
  /** This is `JSON.parse` output: a key no branch below reads is still legal. */
  [key: string]: unknown;
}

/** What one tool call hands back to the turn loop. */
interface ToolResult {
  text: string;
  endTurn?: boolean | undefined;
  imageB64?: string | undefined;
  caption?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/** What the saved-login shortcut did before the harness gets its first turn. */
interface SavedLogin {
  did: boolean;
  brief: string;
  imageB64?: string | null | undefined;
}

/**
 * The `/responses` body SpaceXAI answers `web_search` with. Open at every level:
 * the readers below walk it defensively because a provider that changes shape
 * must degrade to "no text, no citations", never throw.
 */
interface SearchResponse {
  output_text?: unknown;
  output?: {
    type?: unknown;
    text?: unknown;
    content?: { text?: unknown; annotations?: { url?: unknown }[] | undefined }[] | undefined;
  }[] | undefined;
  citations?: unknown;
  /**
   * Spelled as an object only. A provider that answers a bare string still
   * reaches the caller through the `|| json.error` fallback, which is exactly
   * what reading `.message` off a string yields at runtime: undefined.
   */
  error?: { message?: string | undefined } | undefined;
}

/** One NDJSON line off `grok --output-format streaming-json`. Untrusted. */
interface GrokEvent {
  type?: string | undefined;
  data?: unknown;
  text?: unknown;
  result?: unknown;
  tool?: unknown;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  rawInput?: { command?: unknown; query?: string | undefined; q?: string | undefined } | undefined;
  rawOutput?: { command?: unknown } | undefined;
}

/** What `runTurn` is called with. */
export interface RunTurnOptions {
  bot: AgentBot;
  settings: AgentSettings;
  userText: string;
  emit: Emit;
  hidden?: boolean | undefined;
  images?: string[] | undefined;
  signal?: AbortSignal | undefined;
  /** Chat lines the user sent while this turn was already running. */
  pullNudges?: (() => string[]) | undefined;
  persistUser?: boolean | undefined;
}

let dispatchTeammate: DispatchTeammate | null = null;
let deliverReply: DeliverReply | null = null;
let stopBotFn: BotIdFn | null = null;
let endTurnFn: BotIdFn | null = null;
export function setTeamDispatch(fn: DispatchTeammate | null): void {
  dispatchTeammate = fn;
}
export function setTeamReply(fn: DeliverReply | null): void {
  deliverReply = fn;
}
export function setStopBot(fn: BotIdFn | null): void {
  stopBotFn = fn;
}
export function setEndTurn(fn: BotIdFn | null): void {
  endTurnFn = fn;
}
function endTurnKeepBot(id: string): void {
  if (typeof endTurnFn === "function") endTurnFn(id);
}

export async function orchestratorReply({ bot, settings, userText }: { bot: AgentBot; settings: AgentSettings; userText: string }): Promise<string | null> {
  const harness = resolveClient(settings);
  if (harness.kind !== "openai") return null;
  const lastTask = [...(bot.messages || [])]
    .reverse()
    .find((m) => m.role === "user" && !m.hidden && String(m.content || "").trim() !== String(userText || "").trim());
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
        content: `You are ${bot.name}, in the middle of computer work. Answer the user's message from what you have actually done so far, in the first person, briefly and specifically.`,
      },
      {
        role: "user",
        content: `What I was asked to do:\n${String(lastTask?.content || "the current computer work").slice(0, 400)}\n\nWhat I have actually done so far:\n${work || "nothing logged yet"}\n\nUser:\n${userText}`,
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

export const HARNESS_PROVIDERS: HarnessProvider[] = [
  { id: "grok-build", label: "Grok Build", kind: "cli-host" },
  { id: "hermes", label: "Hermes", kind: "cli-host" },
  { id: "claude", label: "Claude", kind: "cli-host" },
  { id: "codex", label: "Codex", kind: "cli-host" },
  { id: "cursor", label: "Cursor", kind: "cli-host" },
  { id: "ollama", label: "Ollama", kind: "openai-local" },
  { id: "lmstudio", label: "LM Studio", kind: "openai-local" },
  { id: "spacexai", label: "SpaceXAI", kind: "openai" },
  { id: "openrouter", label: "OpenRouter", kind: "openai" },
  { id: "openai", label: "OpenAI", kind: "openai" },
  { id: "custom", label: "Custom API", kind: "openai" },
];

// The `custom` key is spelled required so the `|| OPENAI_API_DEFAULTS.custom`
// fallback below stays a value, not a `| undefined`, under noUncheckedIndexedAccess.
const OPENAI_API_DEFAULTS: { custom: OpenAiApiDefault; [provider: string]: OpenAiApiDefault | undefined } = {
  spacexai: { baseUrl: "https://api.x.ai/v1", model: "grok-4.6" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  custom: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

export function normalizeProvider(p: unknown): string {
  const id = String(p || "").trim();
  if (id === "grok-oauth") return "spacexai";
  if (HARNESS_PROVIDERS.some((x) => x.id === id)) return id;
  return "grok-build";
}

export function harnessFor(
  bot: AgentBot | null | undefined,
  settings: AgentSettings | null | undefined,
): HarnessConfig & { provider: string; model: string } {
  const global = settings?.harness || {};
  const local = bot?.harness || {};
  const provider = normalizeProvider(local.provider && local.provider !== "default" ? local.provider : global.provider);
  const model = (local.model && String(local.model).trim()) || (global.provider === provider ? global.model : "") || "";
  return { ...global, provider, model };
}

export function resolveClient(settings: AgentSettings | null | undefined, bot?: AgentBot | null | undefined): ResolvedClient {
  const h = harnessFor(bot, settings);
  if (h.provider === "claude" || h.provider === "codex" || h.provider === "hermes" || h.provider === "grok-build" || h.provider === "cursor") {
    return {
      kind: "cli-host",
      provider: h.provider,
      model:
        h.provider === "grok-build"
          ? h.model || "grok-4.6"
          : h.provider === "cursor"
            ? h.model || "cursor-grok-4.6-low"
            : h.model,
    };
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
  const apiDef = OPENAI_API_DEFAULTS[h.provider] || OPENAI_API_DEFAULTS.custom;
  const baseUrl = (h.baseUrl && String(h.baseUrl).trim()) || apiDef.baseUrl;
  const apiKey =
    (h.apiKey && h.apiKey.trim()) ||
    process.env[h.apiKeyEnv || ""] ||
    (h.provider === "spacexai" ? process.env.XAI_API_KEY : "") ||
    (h.provider === "openai" ? process.env.OPENAI_API_KEY : "") ||
    (h.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : "");
  if (!apiKey) throw new Error("No API key. Paste one in Settings → Harness, or set it on the API setup screen.");
  const headers =
    h.provider === "openrouter"
      ? { "HTTP-Referer": "https://sub8.bot", "X-Title": "Sub8" }
      : undefined;
  return {
    kind: "openai",
    model: h.model || apiDef.model,
    provider: h.provider || "custom",
    baseUrl,
    client: new OpenAI({ apiKey, baseURL: baseUrl.replace(/\/+$/, ""), defaultHeaders: headers }),
  };
}

/** Cheap live check that the configured harness (default SpaceXAI) answers. */
export async function pingHarness(
  settings: AgentSettings,
  bot?: AgentBot | null | undefined,
  providerOverride?: string | undefined,
): Promise<HarnessPing> {
  const prev = settings?.harness || {};
  const cli =
    providerOverride === "hermes" ||
    providerOverride === "claude" ||
    providerOverride === "codex" ||
    providerOverride === "cursor" ||
    providerOverride === "grok-build";
  const forced = providerOverride
    ? {
        ...settings,
        harness: {
          ...prev,
          provider: providerOverride,
          // Do not leak the default Grok model onto Claude / Codex / Hermes / Cursor.
          model: cli ? (providerOverride === "cursor" ? "cursor-grok-4.6-low" : "") : providerOverride === prev.provider ? prev.model || "" : "",
        },
      }
    : settings;
  // A Settings tab test is about that engine, not the selected Bot's harness.
  const harness = resolveClient(forced, providerOverride ? null : bot);
  const provider = harness.provider || forced.harness?.provider || "spacexai";
  if (harness.kind === "cli-host") {
    const r = await hostCli.pingHostCli(harness.provider);
    const blob = r.error || r.log || r.sample || "";
    if (!r.ok && looksLikeAuthFailure(blob)) {
      return {
        ...r,
        provider: harness.provider,
        kind: "cli-host",
        model: harness.model,
        error: rewriteHarnessOutput(harness.provider, blob),
        log: rewriteHarnessOutput(harness.provider, blob),
      };
    }
    return { ...r, provider: harness.provider, kind: "cli-host", model: harness.model };
  }
  if (harness.kind === "grok-build") {
    const ps = await vm.docker(["ps", "--format", "{{.Names}}", "--filter", "name=localbot-"]);
    const box = (ps.out || "").split("\n").map((s: string) => s.trim()).find(Boolean);
    if (!box) {
      return {
        ok: false,
        provider: "grok-build",
        kind: "grok-build",
        model: harness.model,
        error: "Grok Build only runs inside a bot computer, never on this Mac. Start a bot first.",
      };
    }
    // `as AgentBot`: unreachable (see `GrokBuildClient`). The probe bot this dead
    // branch builds carries only a container — no id, no transcript — which is
    // why nothing else in the file has to model a bot that thin.
    const sample = await runGrokBuild(harness, "Reply with only the word PONG.", undefined, { vm: { container: box } } as AgentBot);
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
    // `!`: `models.length` was checked on the line above.
    harness.model = models[0]!;
  }
  const resp = await harness.client.chat.completions.create({
    model: harness.model,
    messages: [{ role: "user", content: "Reply with only the word PONG." }],
    max_tokens: 64,
  });
  const msg: ChatResponseMessage = resp.choices?.[0]?.message || {};
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

async function teamPrompt(bot: AgentBot): Promise<string> {
  return ctx.teamDeskPrompt(bot);
}

async function loadSystemPrompt(
  bot: AgentBot,
  settings: AgentSettings | undefined,
  { hidden = false, compactRoutines = false }: { hidden?: boolean | undefined; compactRoutines?: boolean | undefined } = {},
): Promise<string> {
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
${routines.promptBlock(bot, { compact: compactRoutines, timeZone: ctx.resolveZone(settings) })}
${await teamPrompt(bot)}
${voice}

## Sub8
After send_message, if the user asked for something on the desktop (research, Chrome, files they can see, clicks): web pages go through \`browser\` (navigate/snapshot/click ref); pixels and dialogs through \`computer\`.
web_search is available for facts. Prefer it over opening Google unless the user asked to use the browser.
Routines: ONE standing job, and only when the user asked to keep doing something on a clock (every N minutes, hourly, daily, or every morning). "Check again", "try again", "resume", and one-shot desktop work are NOT routines — do the work now, do not upsert. "Run" / "resume" means execute, not rewrite. Never replace a long brief with the chat line. Never delete the only routine unless they said delete.
If a submit already landed or the UI is still loading, do not submit the same thing again. If a click fails twice, stop repeating it.
${await vault.promptBlock(bot.id)}
`;
}

export function publicBot(
  bot: AgentBot,
  { tail }: { tail?: number | undefined } = {},
): AgentBot & { messageCount: number; messagesTruncated: boolean } {
  const all = bot.messages || [];
  // `!`: Number.isFinite is not a type guard, but it just proved this is a number.
  const limit = Number.isFinite(tail) ? Math.max(0, tail!) : 24;
  const messages = all.length > limit ? all.slice(-limit) : all;
  return {
    ...bot,
    messages: messages.map((m) => ({ ...m, imagePath: undefined, imageB64: undefined })),
    routines: bot.routines || [],
    messageCount: all.length,
    messagesTruncated: all.length > messages.length,
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

// The destructuring pattern stays on one line: tsc reprints it verbatim, and a
// wrapped one would emit a trailing comma the original never had.
async function tryDeskBrain({ bot, settings, userText, emit, signal }: {
  bot: AgentBot;
  settings?: AgentSettings | undefined;
  userText: string;
  emit: Emit;
  signal?: AbortSignal | undefined;
  /** Passed by `runTurn` and read by nobody: the desk harness builds its own prompt. */
  hidden?: boolean | undefined;
}): Promise<AgentBot | null> {
  const token = settings?.__internalToken || "";
  const wantEnsure = String(process.env.DESK_HARNESS || "") === "1" || Boolean(bot?.vm?.hostHarnessPort);
  let ep: ResolvedEndpoint | null = null;
  try {
    // Two erase-only assertions, both about shapes this file does not own.
    // `ResolveHarnessOptions.mappedPort` is `number | string | undefined` and
    // this passes `null` for "no mapping" — resolveHarness reads it through
    // `Number(... || 0)`, where null and undefined are the same absent port —
    // and `ensureLocalHarness` resolves a `LocalHarness`, an interface, which
    // carries no implicit index signature and so is not assignable to the open
    // `EnsuredHarness` that option declares. The result is asserted for the
    // matching reason: one of resolveHarness's two branches spreads whatever
    // `ensure` returned through `EnsuredHarness`, widening `port` and `token`
    // to `unknown`; both branches answer a number and a string.
    ep = await deskClient.resolveHarness({
      bot,
      token,
      mappedPort: bot?.vm?.container ? vm.cachedHarnessPort(bot.vm.container) : null,
      ensure: wantEnsure
        ? async () => {
            try {
              return await ensureLocalHarness({ token, bot });
            } catch {
              return null;
            }
          }
        : undefined,
    } as deskClient.ResolveHarnessOptions) as ResolvedEndpoint | null;
  } catch {
    ep = null;
  }
  if (!ep?.url && bot?.vm?.container && !bot.vm.harnessPort) {
    const port = await vm.publishHarnessWithoutRecreate(bot.vm.container, bot.vm.novncPort, () => {}).catch(() => null);
    if (port) {
      bot.vm.harnessPort = port;
      ep = await deskClient.resolveHarness({ bot, token, mappedPort: port }).catch(() => null) as ResolvedEndpoint | null;
    }
  }
  if (!ep?.url) return null;
  if (bot.vm && ep.port && ep.via === "desk") bot.vm.harnessPort = ep.port;
  if (bot.vm && ep.port && ep.via === "host") bot.vm.hostHarnessPort = ep.port;
  if (ep.via === "desk" && !(await deskClient.harnessCanTurn(ep.url))) return null;
  try {
    const events: deskClient.DeskEvent[] = [];
    const result = await deskClient.runDeskTurn({
      url: ep.url,
      token: ep.token || token,
      body: {
        botId: bot.id,
        content: userText,
        system: `You are the Bot named "${bot.name || "Bot"}". ${String(bot.description || "").trim()}`.trim(),
        display: Number(String(bot.vm?.display || ":1").replace(":", "")) || 1,
      },
      signal,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === "tool") emit("tool", { name: ev.name, args: ev.args || {} });
        if (ev.type === "delta" && ev.text) emit("delta", { text: ev.text });
        if (ev.type === "error") emit("error", { error: ev.message });
      },
    });
    const text = String(result?.content || "").trim();
    if (deskClient.deskTurnFailed(events, text)) return null;
    if (signal?.aborted) return bot; // the stop handler already said "Stopped."
    if (text) {
      const msg = { id: `a${Date.now()}`, role: "assistant", content: text, ts: Date.now() };
      bot.messages.push(msg);
      emit("message", msg);
    }
    return bot;
  } catch {
    return null;
  }
}

// `{} as RunTurnOptions`: the default is a guard that would throw on the very
// next line, and every caller passes the whole record. The assertion is erased,
// so the emitted default is the same bare `{}` it has always been.
export async function runTurn({ bot, settings, userText, emit, hidden = false, images = [], signal, pullNudges, persistUser = true }: RunTurnOptions = {} as RunTurnOptions): Promise<AgentBot> {
  if (!Array.isArray(bot.routines)) bot.routines = [];
  await memory.ensureLayout(bot).catch(() => {});
  if (
    !hidden &&
    !settings?.__replyTo &&
    !routines.looksLikeTeammateTraffic(userText) &&
    routines.looksLikeSchedule(userText)
  ) {
    const parsed = routines.parseSchedule(userText);
    // `!` twice: `looksLikeSchedule` said yes on the line above, and every text it
    // says yes to is one `parseSchedule` parses. A text that split those two would
    // have thrown here before this file had types too.
    //
    // `as RoutineSpec`: that type spells `intervalMs` as `number | null` and
    // `schedule` as `unknown`, neither with an explicit `| undefined`, and
    // `parseSchedule` answers with exactly one of the two present. `upsertRoutine`
    // reads both through `Number.isFinite` / `normalizeSchedule`, which treat an
    // undefined value and a missing key identically.
    const { routine, merged, rejected } = routines.upsertRoutine(bot, {
      instruction: userText,
      intervalMs: parsed!.intervalMs,
      schedule: parsed!.schedule,
      timeZone: ctx.resolveZone(settings),
    } as routines.RoutineSpec);
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
  const local = harness.provider === "ollama" || harness.provider === "lmstudio";
  const system = await loadSystemPrompt(bot, settings, { hidden, compactRoutines: local });

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

  const history: ChatMessage[] = [
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

  let savedLogin: SavedLogin | null = null;
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

  const viaDesk = await tryDeskBrain({ bot, settings, userText: savedLogin?.did ? `${userText}\n\n${savedLogin.brief}` : userText, emit, signal, hidden });
  if (viaDesk) return viaDesk;

  if (harness.kind === "cli-host") {
    emit("tool", { name: "computer", args: { action: "screenshot" } });
    const work = {
      id: `tl${Date.now()}cli`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Starting on the computer",
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
    if (signal?.aborted) return bot; // the stop handler already said "Stopped."
    const msg = { id: `a${Date.now()}`, role: "assistant", content: text, ts: Date.now() };
    if (/signed out|sign in, then send/i.test(text)) emit("harness-auth", { provider: harness.provider });
    bot.messages.push(msg);
    emit("message", msg);
    return bot;
  }

  if (harness.kind === "grok-build") {
    if (!bot.grokSessionId) bot.grokSessionId = bot.id;
    const grokText = savedLogin?.did ? `${userText}\n\n${savedLogin.brief}` : userText;
    emit("tool", { name: "computer", args: { action: "screenshot" } });
    const work = {
      id: `tl${Date.now()}gb`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Starting on the computer",
      ts: Date.now(),
    };
    bot.messages.push(work);
    emit("message", work);
    const text = await runGrokBuild(harness, grokText, signal, bot, emit, { settings, hidden });
    if (signal?.aborted) return bot; // the stop handler already said "Stopped."
    const msg = { id: `a${Date.now()}`, role: "assistant", content: text, ts: Date.now() };
    bot.messages.push(msg);
    emit("message", msg);
    if (bot.vm?.status === "running") {
      try {
        // `as AgentDeskBot` here and at every other desk call in this file: the
        // guard on the line above (or, in `execTool`, the `hostTools` gate) has
        // proved the computer is running, which means `bot.vm` is there.
        // TypeScript narrows the property, not the record that carries it.
        await computerAction(bot as AgentDeskBot, { action: "screenshot" }, emit);
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
          // `as Error`: same shape vm.mts uses for a caught value it only reads
          // `.message` off. A non-Error rejection still renders as `undefined`,
          // exactly as it did before.
          content: `Computer action failed: ${(err as Error).message}`,
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
  const turnT0 = Date.now();
  const turnTools: Record<string, number> = {};
  const turnUsage = { llmCalls: 0, promptTokens: 0, completionTokens: 0 };

  const stopped = () => Boolean(signal?.aborted);
  // "Stopped." is written once, by whoever handled the stop (POST
  // /api/bots/:id/stop). A turn that notices the abort just leaves quietly —
  // one stop used to post the word twice.
  while (steps++ < maxSteps) {
    if (stopped()) return bot;
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
        content: "The message(s) above arrived while you were working. If they change what you should do, do that. If they ask something, answer it in one line with send_message. Otherwise continue the same work.",
      });
    }
    const resp = local
      ? await completeLocal(harness, history, userText, signal)
      : await harness.client.chat.completions.create(
          { model: harness.model, messages: history, tools: TOOLS, tool_choice: "auto" },
          signal ? { signal } : undefined,
        );
    turnUsage.llmCalls += 1;
    turnUsage.promptTokens += Number(resp.usage?.prompt_tokens) || 0;
    turnUsage.completionTokens += Number(resp.usage?.completion_tokens) || 0;
    const msg = resp.choices?.[0]?.message;
    if (!msg) break;
    const toolCalls = local ? coerceToolCalls(msg) : msg.tool_calls || [];

    if (msg.content && msg.content.trim() && !toolCalls.length) {
      lastVisible = msg.content.trim();
      const planning = local && looksLikePlanning(lastVisible);
      const think = String(msg.reasoning_content || msg.reasoning || "").trim() || (planning ? lastVisible : "");
      emitThink(bot, emit, think, { hidden });
      if (!planning) {
        const out = { id: `a${Date.now()}`, role: "assistant", content: lastVisible, ts: Date.now() };
        bot.messages.push(out);
        emit("message", out);
      }
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
      if (local && (planning || localWantsTools(userText, 0)) && steps < maxSteps - 1) {
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

    if (!toolCalls.length) break;

    const rem = reminderFor(bot.messages, { hidden });
    if (rem && !toolCalls.some((c) => String(c.function?.name || "") === "send_message")) {
      history.push({ role: "user", content: rem.content });
    }

    const think = String(msg.reasoning_content || msg.reasoning || "").trim()
      || (msg.content && String(msg.content).trim())
      || "";
    emitThink(bot, emit, think, { hidden });

    history.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      if (stopped()) return bot;
      // `!` twice: `WireToolCall.function` is optional only because the SDK's
      // response union also models custom tool calls. Every tool in the catalog
      // is `type: "function"`, and `extractToolCallsFromContent` builds nothing
      // else, so a call that reaches here always carries one.
      const name = call.function!.name;
      let args: ToolArgs = {};
      try {
        args = JSON.parse(call.function!.arguments || "{}");
      } catch {
        args = {};
      }
      emit("tool", { name, args });
      const tkey = name === "computer" ? `computer/${args.action || ""}` : name === "browser" ? `browser/${args.action || ""}` : name;
      turnTools[tkey] = (turnTools[tkey] || 0) + 1;
      if (name === "computer") usedComputer = true;
      if (name === "vault_fill") usedVaultFill = true;
      const result = await execTool(bot, name, args, emit, settings);
      if (result?.endTurn) return bot;
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
  try {
    console.log(
      JSON.stringify({
        turnlog: {
          botId: bot.id,
          harness: harness?.provider || (local ? "local" : ""),
          outcome: "local",
          ms: Date.now() - turnT0,
          steps: steps - 1,
          ...turnUsage,
          tools: turnTools,
          reply: String(lastVisible || "").slice(0, 80),
        },
      }),
    );
  } catch {
    /* telemetry is best-effort */
  }
  return bot;
}

/** After the first tool, do not re-send a 12k standing brief on every Qwen step. */
export function localContinueQuery(userText: unknown): string {
  const t = String(userText || "").trim();
  if (t.length < 1600) return t || "Continue.";
  return "Continue the same standing job. Do not re-read memory files unless a specific fact is missing. Prefer computer screenshot / open / click. One real desktop step.";
}

function lastVisualImage(history: readonly (ChatMessage | null | undefined)[] | null | undefined): ContentPart | null {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    // `!`: the loop bound is `(history || []).length`, which is 0 when there is
    // no history, so the body never runs without one.
    const m = history![i];
    if (m?.role === "tool") {
      const t = String(m.content || "");
      if (!/Screenshot|Mouse pointer|Opened Chrome|Clicked/i.test(t)) return null;
      continue;
    }
    if (Array.isArray(m?.content)) {
      const img = m.content.find((p) => p?.type === "image_url");
      if (img) return img;
    }
    if (m?.role === "assistant" || (m?.role === "user" && typeof m.content === "string")) return null;
  }
  return null;
}

/** Qwen 3.x jinja dies on long / consecutive-user histories ("No user query found"). */
export function qwenSafeMessages(
  history: readonly (ChatMessage | null | undefined)[] | null | undefined,
  userText: unknown,
): ChatMessage[] {
  const sys: ChatMessage[] = [];
  const compact: ChatMessage[] = [];
  const toolNotes: string[] = [];
  const lastImage = lastVisualImage(history);
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
      if (texts.trim()) compact.push({ role: m.role, content: texts.slice(-2000) });
      continue;
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "user" && (content.startsWith("[routine]") || !content.trim())) continue;
    if (m.role === "assistant" && !content.trim() && !m.tool_calls) continue;
    if (compact.at(-1)?.role === m.role && !m.tool_calls) {
      // `!`: the condition above matched that row's `.role`, so there is one.
      compact.at(-1)!.content = content.slice(-2000);
      continue;
    }
    compact.push({ role: m.role, content: content.slice(-2000) });
  }
  while (compact.at(-1)?.role === "user") compact.pop();
  const bits = [String(userText || "").trim() || "Continue."];
  if (toolNotes.length) bits.push(`Last tool results:\n${toolNotes.slice(-3).join("\n")}`);
  bits.push("Do the next real desktop step. Do not only say you will do it. Do not re-cat notes you already read this turn.");
  let tail = compact.slice(-3);
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

function packChars(messages: readonly ChatMessage[] | null | undefined): { n: number; image: boolean } {
  let n = 0;
  let image = false;
  for (const m of messages || []) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === "text") n += String(p.text || "").length;
        if (p?.type === "image_url") image = true;
      }
    }
  }
  return { n, image };
}

async function completeLocal(
  harness: OpenAiClient,
  history: readonly ChatMessage[] | null | undefined,
  userText: unknown,
  signal: AbortSignal | undefined,
): Promise<ChatResponse> {
  const toolSteps = (history || []).filter((m) => m.role === "tool").length;
  const query = toolSteps === 0 ? String(userText || "").trim() || "Continue." : localContinueQuery(userText);
  const toolChoice = localWantsTools(userText, toolSteps) ? "required" : "auto";
  const attempts = [
    qwenSafeMessages(history, query),
    [...(history || []).filter((m) => m.role === "system"), { role: "user", content: query }],
  ];
  let lastErr: unknown;
  for (const messages of attempts) {
    const { n, image } = packChars(messages);
    const bodies: ChatRequest[] = [
      {
        model: harness.model,
        messages,
        tools: TOOLS,
        tool_choice: toolChoice,
        max_tokens: 1536,
        reasoning_effort: "low",
      },
      {
        model: harness.model,
        messages,
        tools: TOOLS,
        tool_choice: toolChoice,
        max_tokens: 1536,
      },
      {
        model: harness.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 1536,
      },
    ];
    for (const body of bodies) {
      const t0 = Date.now();
      try {
        const resp = await harness.client.chat.completions.create(body, signal ? { signal } : undefined);
        console.log(
          `local-llm ${Date.now() - t0}ms model=${harness.model} step=${toolSteps} chars=${n} image=${image} think=${Boolean(body.reasoning_effort)}`,
        );
        return resp;
      } catch (err) {
        lastErr = err;
        // `as Error`: only `.message` is read, and the `|| err` fallback is what
        // renders a rejection that is not an Error.
        const msg = String((err as Error)?.message || err);
        console.log(`local-llm fail ${Date.now() - t0}ms step=${toolSteps} chars=${n} ${msg.slice(0, 160)}`);
        if (!/No user query found|jinja template|reasoning_effort|Unrecognized request argument|tool_choice/i.test(msg)) throw err;
      }
    }
  }
  throw lastErr;
}

function toolSummary(name: string, args: ToolArgs = {}, result: string = ""): string {
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
  if (name === "memory") {
    const a = String(args.action || "read");
    const p = String(args.path || "").split("/").pop() || "notes";
    if (a === "list") return "Listed memory files";
    if (a === "append") return `Noted ${p}`;
    if (a === "write") return `Updated ${p}`;
    return `Read ${p}`;
  }
  if (name === "upsert_routine") return args.name ? `Set up “${args.name}”` : "Updated a routine";
  if (name === "list_routines") return "Checked routines";
  if (name === "disable_routine") return "Paused a routine";
  if (result && /^error:/i.test(result)) return result.slice(0, 80);
  return name.replaceAll("_", " ");
}

function isDone(text: string | null | undefined): boolean {
  return /\b(done|finished|all set|that's it|thats it|completed|closed the loop|nothing else|task is complete)\b/i.test(
    text || ""
  );
}

/**
 * Small-local-model crutch (Ollama / LM Studio): once the model has taken a
 * tool step, keep tool_choice "required" so it does not drift back into
 * narrating. Whether the FIRST step needs a tool is the model's call — there is
 * no reading of the user's words here.
 */
export function localWantsTools(_userText: unknown, toolSteps: number = 0): boolean {
  return Number(toolSteps) > 0;
}

export function extractToolCallsFromContent(content: unknown): ToolCall[] {
  const text = String(content || "");
  const out: ToolCall[] = [];
  const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  for (const m of blocks) {
    // `!`: group 1 is not optional in the pattern, so a match always carries it.
    const raw = m[1]!.trim();
    try {
      const parsed: Record<string, unknown> = JSON.parse(raw);
      const name = String(parsed.name || parsed.function || "").trim();
      if (!name) continue;
      let args = parsed.arguments ?? parsed.params;
      if (typeof args === "undefined") {
        const rest = { ...parsed };
        delete rest.name;
        delete rest.function;
        args = rest;
      }
      out.push({
        type: "function",
        id: `qwen${Date.now()}${out.length}`,
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      });
    } catch {
      const name = (raw.match(/^([a-z_][\w]*)/i) || [])[1];
      const json = raw.match(/\{[\s\S]*\}/);
      if (!name || !json) continue;
      out.push({
        type: "function",
        id: `qwen${Date.now()}${out.length}`,
        function: { name, arguments: json[0] },
      });
    }
  }
  return out;
}

function coerceToolCalls(msg: ChatResponseMessage | null | undefined): WireToolCall[] {
  if (msg?.tool_calls?.length) return msg.tool_calls;
  return extractToolCallsFromContent(msg?.content);
}

function looksLikePlanning(text: unknown): boolean {
  const t = String(text || "").trim();
  if (!t || isDone(t)) return false;
  return /^(let me|i'll|i will|i am going to|next i('ll| will)|rather than)/im.test(t);
}

export function loginUrlFor(acc: { site?: string | undefined } | null | undefined, needle: string): string {
  const site = String(acc?.site || "").trim();
  if (/^https?:\/\//i.test(site) && !/mail\.google\.com\/?$/i.test(site)) return site;
  if (/gmail|mail\.google/i.test(`${site} ${needle}`)) {
    return "https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/";
  }
  if (/^https?:\/\//i.test(site)) return site;
  if (site) return site.includes(".") ? `https://${site.replace(/^\/+/, "")}` : "";
  if (/\bgmail\b/i.test(needle)) {
    return "https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/";
  }
  return "";
}

export function loginNeedle(text: unknown): string {
  const t = String(text || "").trim();
  if (!/\b(log\s*in|sign\s*in|signin|sign into)\b/i.test(t)) return "";
  const m = t.match(/\b(?:log\s*in|sign\s*in|signin|sign into)\s+(?:to\s+)?(.+)$/i);
  // `!`: group 1 is not optional in the pattern, so a match always carries it.
  return (m ? m[1]! : "").trim().toLowerCase().replace(/[.?!\s]+$/g, "");
}

export function scoreVaultAccount(
  acc: { label?: string | undefined; site?: string | undefined; username?: string | undefined } | null | undefined,
  needle: unknown,
): number {
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

function emitActivity(bot: AgentBot, emit: Emit, name: string, action: string, summary: string): void {
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

async function maybeRunSavedLogin(
  bot: AgentBot,
  userText: unknown,
  emit: Emit,
  signal: AbortSignal | undefined,
): Promise<SavedLogin | null> {
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
  await computerAction(bot as AgentDeskBot, { action: "open", text: url }, emit);
  emitActivity(bot, emit, "computer", "open", `Opened ${url}`);
  if (signal?.aborted) return { did: true, brief: "Stopped before filling the login." };
  await vm.wait(1600);
  emit("tool", { name: "vault_fill", args: { account_id: acc.id, field: "username" } });
  const user = await vault.fillIntoDesktop(bot as AgentDeskBot, acc.id, "username");
  emitActivity(bot, emit, "vault_fill", "vault_fill", toolSummary("vault_fill", { field: "username" }));
  await computerAction(bot as AgentDeskBot, { action: "key", keys: "Return" }, emit);
  emitActivity(bot, emit, "computer", "key", "Pressed Return");
  await vm.wait(1800);
  if (signal?.aborted) return { did: true, brief: "Stopped after the username." };
  emit("tool", { name: "vault_fill", args: { account_id: acc.id, field: "password" } });
  const pass = await vault.fillIntoDesktop(bot as AgentDeskBot, acc.id, "password");
  emitActivity(bot, emit, "vault_fill", "vault_fill", toolSummary("vault_fill", { field: "password" }));
  await computerAction(bot as AgentDeskBot, { action: "key", keys: "Return" }, emit);
  emitActivity(bot, emit, "computer", "key", "Pressed Return");
  await vm.wait(1600);
  const shot = await computerAction(bot as AgentDeskBot, { action: "screenshot" }, emit);
  emitActivity(bot, emit, "computer", "screenshot", "Looked at the screen");
  const brief =
    `Sub8 opened ${url} and pasted the saved ${acc.label} username${user.ok ? "" : " (username paste failed)"} ` +
    `then password${pass.ok ? "" : " (password paste failed)"}. Look at the screenshot. ` +
    `If this is the inbox or the signed-in home, tell the user you're in. ` +
    `If you see 2FA, a Choose-an-account picker, or a wrong field, click that. Do not open Gmail again from scratch.`;
  return { did: true, brief, imageB64: shot.imageB64 || null };
}

const lastThinkAt = new Map<string, number>();

function emitThink(bot: AgentBot, emit: Emit, text: unknown, { hidden }: { hidden?: boolean | undefined } = {}): void {
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

function waitForPaint(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 500));
}

async function shotPayload(bot: AgentDeskBot, emit: Emit, note: string = ""): Promise<ToolResult> {
  const shot = await vm.screenshot(bot);
  emit("screen", { url: `/api/bots/${bot.id}/screen?t=${Date.now()}`, width: shot.width, height: shot.height });
  const loc = await vm.mouseLocation(bot);
  const caption = `${note} Screenshot ${shot.width}x${shot.height}. Mouse pointer is at ${loc.x},${loc.y} (drawn on the image). Click the center of a control you can see on THIS image.`.trim();
  return { text: caption, imageB64: shot.buf.toString("base64"), caption, width: shot.width, height: shot.height };
}

async function execTool(
  bot: AgentBot,
  name: string,
  args: ToolArgs,
  emit: Emit,
  settings: AgentSettings | undefined,
): Promise<ToolResult> {
  try {
    const hostTools = new Set([
      "send_message",
      "upsert_routine",
      "list_routines",
      "disable_routine",
      "list_teammates",
      "message_teammate",
      "list_tasks",
      "set_job",
      "update_task",
      "ask_user",
      "create_teammate",
      "rename_bot",
      "update_bot",
      "delete_teammate",
      "web_search",
      "web_fetch",
      "read",
      "create_channel",
      "update_channel",
      "task",
      "check_subagent",
      "message_subagent",
      "stop_subagent",
      "cloud_agent",
      "await_shell",
      "update_state",
      "request_box_help",
      "vault_list",
      "memory",
      "add_mcp_server",
      "get_mcp_tools",
      "call_mcp_tool",
      "authenticate_mcp_server",
    ]);
    if (bot.vm?.status !== "running" && !hostTools.has(name)) {
      return { text: "Computer is not running yet." };
    }
    if (name === "browser") {
      const r = await vm.pageAgent(bot as AgentDeskBot, args);
      emit("tool", { name: "browser", args });
      const activity = {
        id: `tl${Date.now()}br`,
        role: "activity",
        kind: "tool",
        name: "browser",
        action: args.action,
        summary: args.action === "snapshot" ? "Read the page" : `Browser ${args.action}`,
        ts: Date.now(),
      };
      bot.messages.push(activity);
      emit("message", activity);
      // Redact, as the `shell` handler below and the mcp-sub8 twin both do.
      // vault_fill pastes a secret into whatever the desktop has focused --
      // pasteSecret is xdotool-level, so it cannot tell a password field from
      // a plain one -- and page-agent's snapshot emits value="<AX value>" for
      // every textbox. Without this a model could paste a credential into an
      // ordinary input and read it straight back out of the snapshot, into its
      // own context and the stored transcript.
      return { text: vault.redactSecrets(r.text || "", await vault.listSecrets()) };
    }
    if (name === "memory") {
      const r = await memory.handleMemory(bot, args);
      // Redact. `read` and `memory` were the two tool sinks the redaction sweep
// missed, so any credential sitting in a /config file came back to the
      // model verbatim and into the stored transcript -- including
      // /config/.desk-token, which resolveReadPath happily resolves.
      return { text: vault.redactSecrets(r.text || "", await vault.listSecrets()) };
    }
    if (name === "vault_list") {
      const rows = await vault.grantedAccounts(bot.id);
      return { text: rows.length ? JSON.stringify(rows, null, 2) : "No saved logins granted to this Bot." };
    }
    if (name === "vault_fill") {
      const filled = await vault.fillIntoDesktop(bot as AgentDeskBot, args.account_id, args.field || "password");
      return { text: filled.text };
    }
    if (name === "send_message") {
      if (bot.awaitingUserSelection) return { text: AWAITING_BLOCKED };
      // `as unknown as`: from here the card is a chat row. @sub8/choice models it
      // as an interface, which carries no implicit index signature and so does not
      // overlap the open JSON row type this file and @sub8/store share — the two
      // describe the same object from two sides. Same pair at ask_user and
      // authenticate_mcp_server below. vm.mts spells the same widening this way.
      const card = cardFromSendMessageArgs(bot, args) as unknown as AgentMessage | null;
      if (card) {
        bot.messages.push(card);
        bot.awaitingUserSelection = true;
        await store.patchBot(bot.id, (b) => {
          b.messages = b.messages || [];
          if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card);
          b.awaitingUserSelection = true;
        });
        await Promise.resolve(emit("message", card));
        // The lead asking the user a question must show in the team channel —
        // that is where the user talks to the lead. Same id, so a pick made
        // from the channel answers this card.
        if (bot.teamId && bot.teamRole === "chief") {
          const posted = await teams.appendMessage(bot.teamId, { ...(card as unknown as Record<string, unknown>), speakerId: bot.id, speakerName: bot.name, speakerRole: "chief" });
          emit("team-message", { teamId: bot.teamId, ...posted });
        }
        endTurnKeepBot(bot.id);
        return { text: "asked the user; wait for their pick in chat", endTurn: true };
      }
      const secrets = await vault.listSecrets();
      const out = {
        id: `a${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        role: "assistant",
        speakerId: bot.id,
        speakerName: bot.name,
        speakerRole: bot.teamRole || "",
        content: vault.redactSecrets(String(args.content || ""), secrets),
        ts: Date.now(),
      };
      bot.messages.push(out);
      emit("message", out);
      if (bot.teamId) {
        const posted = await teams.appendMessage(bot.teamId, { ...out, teamId: bot.teamId });
        emit("team-message", { teamId: bot.teamId, ...posted });
        const team = await teams.getTeam(bot.teamId);
        if (bot.teamRole === "chief") {
          const { job, finalized } = teams.maybeFinalizeSummary(team?.job);
          if (finalized) {
            await teams.saveTeam({ ...team, job });
            emit("job", { teamId: bot.teamId, job });
          }
        }
        // Everyone sees the message in the shared log; only the teammates the
        // sender addressed are woken — named in `to`, or @mentioned in the text.
        const bots = await store.loadBots();
        const roster = teams.membersOf(team, bots).map((b) => {
          const bb = b as { id: string; name?: string; teamRole?: string; channelState?: "active" | "hold" };
          return { id: bb.id, name: bb.name, teamRole: bb.teamRole, channelState: bb.channelState };
        });
        const to = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
        const { wake } = teams.routeChannelMessage({ authorId: bot.id, text: out.content, members: roster, to });
        if (wake.length && typeof dispatchTeammate === "function") {
          for (const id of wake) dispatchTeammate(id, out.content, bot);
        }
      }
      return { text: "sent" };
    }
    if (name === "list_teammates") {
      const mates = await teams.listDeskWorkers(bot);
      return {
        text: mates.length
          ? JSON.stringify(
              mates.map((b) => ({ id: b.id, name: b.name, role: b.teamRole || "member" })),
              null,
              2,
            )
          : bot.teamId
            ? "No teammates."
            : "You are not on a team.",
      };
    }
    if (name === "message_teammate") {
      const toId = String(args.bot_id || args.id || "");
      // Same redaction as send_message: sendToAgentContent only trims and
      // truncates, so a secret would land verbatim in the teammate's wake
      // queue, the room and the persisted team history.
      // Same sibling-field tolerance as mcp-sub8: content / message / text / detail.
      const rawBody = [args.content, args.message, args.text, args.detail].map((v) => String(v || "").trim()).find(Boolean) || "";
      const content = vault.redactSecrets(sendToAgentContent(rawBody), await vault.listSecrets());
      if (!content) return { text: "empty message — pass the note in `content`" };
      const room = await channels.getChannel(toId).catch(() => null);
      if (room) {
        // `as`: `sendToAgent` answers a `channel | peer` union that this branch
        // has already decided — `getChannel(toId)` just said the target is a
        // room — but the union does not carry the decision across the call.
        const routed = await sendToAgent(bot.id, toId, content) as { queued: number; channelId: string };
        return { text: `queued to room ${routed.channelId} (${routed.queued} members)` };
      }
      const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
      const bots = await store.loadBots();
      const members = team ? teams.membersOf(team, bots) : [];
      // A name or an id prefix resolves too — see teams.resolveTeammate.
      const mate = teams.resolveTeammate(toId, members);
      if (!mate) {
        const target = teams.resolveTeammate(toId, members, bots) || (await store.getBot(toId));
        if (!target) {
          const names = members.filter((b) => b.id !== bot.id).map((b) => b.name).filter(Boolean).join(", ");
          return { text: `bot not found: "${toId}". Pass bot_id from list_teammates${names ? ` (your teammates: ${names})` : ""}.` };
        }
        // `as`: the peer arm of the same union — the target resolved to a bot.
        const routed = await sendToAgent(bot.id, target.id, content) as { queued: number; botId: string };
        return { text: `queued to ${routed.botId}` };
      }
      // `!` here and on the two `bot.teamId` reads below: `mate` is only non-null
      // when `team` was, and `team` is only non-null when this bot has a teamId.
      const posted = await teams.appendMessage(bot.teamId!, {
        role: "assistant",
        speakerId: bot.id,
        speakerName: bot.name,
        speakerRole: bot.teamRole || "",
        toId: mate.id,
        toName: mate.name,
        content,
      });
      emit("team-message", { teamId: bot.teamId, ...posted });
      const note = {
        id: `a${Date.now()}tm`,
        role: "assistant",
        speakerId: bot.id,
        speakerName: bot.name,
        speakerRole: bot.teamRole || "",
        toId: mate.id,
        toName: mate.name,
        content: `To ${mate.name}: ${content}`,
        ts: Date.now(),
      };
      bot.messages.push(note);
      emit("message", note);
      // `as TaskStatus`: this is the membership test itself — the whole point is
      // that `args.status` is whatever the model sent until this line says otherwise.
      const status = teams.TASK_STATUSES.includes(args.status as teams.TaskStatus) ? args.status : null;
      if (bot.teamRole === "chief") {
        const assigned = await teams.onWorkerAssigned(bot.teamId!, mate.id, {
          label: args.label,
          content,
          status,
          detail: args.detail,
          stepId: args.step_id,
        });
        if (assigned?.team?.job) emit("job", { teamId: bot.teamId, job: assigned.team.job });
        for (const b of assigned?.renamed || []) {
          emit("teammate", {
            bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
          });
        }
        if (assigned?.bot?.name && assigned.bot.name !== mate.name) mate.name = assigned.bot.name;
      } else if (status) {
        const bumped = await teams.patchTeamStep(bot.teamId!, {
          botId: bot.id,
          status,
          detail: args.detail || content,
        });
        if (bumped?.job) emit("job", { teamId: bot.teamId, job: bumped.job });
        for (const b of bumped?.renamed || []) {
          emit("teammate", {
            bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
          });
        }
      }
      if (typeof dispatchTeammate === "function") {
        dispatchTeammate(mate.id, content, bot);
      }
      return { text: `sent to ${mate.name}` };
    }
    if (name === "list_tasks") {
      if (!bot.teamId) return { text: "You are not on a team." };
      const team = await teams.getTeam(bot.teamId);
      if (!team?.job) return { text: "No team job yet. Chief: set_job with title and steps." };
      return { text: JSON.stringify({ title: team.job.title, ...teams.jobProgress(team.job), steps: team.job.steps }, null, 2) };
    }
    if (name === "set_job") {
      if (!bot.teamId) return { text: "You are not on a team." };
      const saved = await teams.setTeamJob(bot.teamId, { title: args.title, steps: args.steps });
      if (!saved?.job) return { text: "could not set job" };
      emit("job", { teamId: bot.teamId, job: saved.job });
      for (const b of saved.renamed || []) {
        emit("teammate", {
          bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
        });
      }
      return { text: `Job “${saved.job.title}” · ${saved.job.steps.length} steps` };
    }
    if (name === "update_task") {
      if (!bot.teamId) return { text: "You are not on a team." };
      const bumped = await teams.patchTeamStep(bot.teamId, {
        stepId: args.step_id,
        label: args.label,
        botId: bot.id,
        status: args.status,
        detail: args.detail,
      });
      if (!bumped?.step) return { text: "no matching step — list_tasks and use label or step_id" };
      emit("job", { teamId: bot.teamId, job: bumped.job });
      for (const b of bumped.renamed || []) {
        emit("teammate", {
          bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
        });
      }
      return { text: `${bumped.step.label}: ${bumped.step.status}${bumped.step.detail ? ` · ${bumped.step.detail}` : ""}` };
    }
    if (name === "ask_user") {
      // `as unknown as AgentMessage`: a chat row from here (see send_message
      // above). Non-null because `cardFromSendMessageArgs` only answers null when
      // it cannot build a card, and a `type: "widget"` spec always builds one —
      // which is why the runtime pushes this unguarded.
      const card = cardFromSendMessageArgs(bot, {
        type: "widget",
        question: args.question,
        hint: args.hint,
        choices: Array.isArray(args.choices) && args.choices.length ? args.choices : teams.BOT_JOB_CHOICES,
        allow_custom: args.allow_custom,
      }) as unknown as AgentMessage;
      bot.messages.push(card);
      bot.awaitingUserSelection = true;
      await store.patchBot(bot.id, (b) => {
        b.messages = b.messages || [];
        if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card);
        b.awaitingUserSelection = true;
      });
      await Promise.resolve(emit("message", card));
      endTurnKeepBot(bot.id);
      return { text: "asked the user; wait for their pick in chat", endTurn: true };
    }
    if (name === "create_teammate") {
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
        bot.messages.push(card);
        await store.patchBot(bot.id, (b) => {
          b.messages = b.messages || [];
          if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card);
        });
        await Promise.resolve(emit("message", card));
        return { text: "asked the user what this Bot should do; wait for their pick" };
      }
      const team = await teams.ensureTeamForBot(bot);
      const harness = {
        ...(bot.harness || {}),
        ...(args.harness || args.provider ? { provider: String(args.harness || args.provider) } : {}),
        ...(args.model
          ? { model: String(args.model) }
          : String(args.harness || args.provider) === "cursor"
            ? { model: "cursor-grok-4.6-low" }
            : {}),
      };
      const { bot: mate } = await teams.addMember(team, {
        name: nm,
        job: args.instructions ? `${job}\n${args.instructions}` : job,
        role: args.role === "chief" ? "chief" : "worker",
        harness,
        color: args.color,
        instructions: args.instructions || job,
      });
      emit("teammate", { bot: { id: mate.id, name: mate.name, teamId: mate.teamId, teamRole: mate.teamRole, color: mate.color, harness: mate.harness, vm: mate.vm } });
      if (mate.teamRole !== "chief") {
        const assigned = await teams.onWorkerAssigned(team.id, mate.id, {
          label: mate.name,
          content: job,
          status: "pending",
        });
        if (assigned?.team?.job) emit("job", { teamId: team.id, job: assigned.team.job });
        for (const b of assigned?.renamed || []) {
          emit("teammate", {
            bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
          });
        }
      }
      const note = {
        id: `a${Date.now()}nb`,
        role: "assistant",
        speakerId: bot.id,
        speakerName: bot.name,
        content: `Created ${mate.name} on this desk to ${job}. They’re in the sidebar on this team.`,
        ts: Date.now(),
      };
      bot.messages.push(note);
      emit("message", note);
      return { text: `created ${mate.name} (${mate.id}) job=${job}` };
    }
    if (name === "rename_bot" || name === "update_bot") {
      const targetId = String(args.bot_id || bot.id);
      const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
      const bots = await store.loadBots();
      const target = bots.find((b) => b.id === targetId);
      if (!target) return { text: "bot not found" };
      if (target.id !== bot.id && (!team || !team.memberIds?.includes(target.id))) {
        return { text: "that Bot is not on your team" };
      }
      // One guarded body for both aliases (see teams.applyBotPatch): rename_bot
      // sets only the name, and a call that smears one string across
      // name/description/instructions is refused, not applied.
      // `as PatchableBot`: that alias is `store.Bot & memory.MemoryBot`, and the
      // two spell `vm.container` differently (`string | null` against `string`).
      // `target` came straight out of `store.loadBots()`, so it is the same row
      // either name describes.
      //
      // `!`: `applyBotPatch` answers `{ ok: false, refused }` or `{ ok: true }`;
      // the refusal text is always there when it says no.
      const patched = await teams.applyBotPatch(target as teams.PatchableBot, args, { tool: name });
      if (!patched.ok) return { text: patched.refused! };
      emit("teammate", { bot: { id: target.id, name: target.name, teamId: target.teamId, teamRole: target.teamRole, color: target.color, harness: target.harness, vm: target.vm } });
      const notes: string[] = [];
      if (patched.ignored.length) notes.push(`rename_bot only sets the name; ignored ${patched.ignored.join(", ")} (use update_bot for those)`);
      // `!`: `prior` is only set when `changed` is non-empty.
      if (patched.prior) notes.push(`previous ${patched.changed!.join("/")} kept on the record as priorIdentity: ${JSON.stringify(patched.prior)}`);
      return { text: `updated ${target.name} (${target.id})${notes.length ? `. ${notes.join(". ")}` : ""}` };
    }
    if (name === "hold_teammate" || name === "resume_teammate") {
      const toId = String(args.bot_id || "");
      if (!toId) return { text: "bot_id required" };
      const target = await store.getBot(toId);
      if (!target) return { text: "bot not found" };
      const state = name === "hold_teammate" ? "hold" : "active";
      await teams.setChannelState(toId, state);
      emit("teammate", { bot: { id: target.id, name: target.name, teamId: target.teamId, teamRole: target.teamRole, channelState: state } });
      return { text: `${target.name} is ${state === "hold" ? "on hold" : "active"}` };
    }
    if (name === "delete_teammate") {
      const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
      // `!` twice: `closeTargetsForBot` answers with exactly one of `error` / `ids`.
      const { ids, error } = await teams.closeTargetsForBot(bot, args);
      if (error) return { text: error };
      if (!ids!.length) return { text: "no workers to close" };
      const labels: string[] = [];
      for (const targetId of ids!) {
        const target = await store.getBot(targetId);
        labels.push(target?.name || targetId);
        if (typeof stopBotFn === "function") stopBotFn(targetId);
        await store.deleteBot(targetId);
        emit("teammate", { gone: targetId });
      }
      if (team) await teams.removeMembers(team, ids);
      await teams.pruneSoloTeams();
      return { text: `deleted ${labels.join(", ")}` };
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
      const instruction = String(args.instruction || "");
      // `as RoutineSpec` for the same reason as the schedule upsert in `runTurn`:
      // that type spells these without an explicit `| undefined`, and the four
      // `|| undefined` fallbacks here are how this call says "leave it alone".
      const { routine, merged, rejected } = routines.upsertRoutine(bot, {
        id: args.id || undefined,
        name: args.name,
        instruction,
        intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
        schedule: args.schedule,
        timeZone: ctx.resolveZone(settings),
        groupKey: args.group_key || undefined,
        forceNew: args.force_new === true,
        forceReplace: args.force_replace === true || instruction.length > 80,
        solo: args.solo !== false,
        replace: args.replace !== false,
        enabled: args.enabled,
      } as routines.RoutineSpec);
      await Promise.resolve(emit("routine", { routine, merged, rejected }));
      if (rejected) {
        return { text: `Did not replace the standing brief. ${rejected}. Do the work instead of rewriting the cron.` };
      }
      // `!` four times: `upsertRoutine` returns a null `routine` only alongside a
      // `rejected` reason, and the branch above already returned on that.
      return {
        text: merged
          ? `Merged into existing "${routine!.name}" (${routine!.groupKey}) ${routines.cadenceLabel(routine, ctx.resolveZone(settings)).toLowerCase()}.`
          : `Created "${routine!.name}" (${routine!.groupKey}) ${routines.cadenceLabel(routine, ctx.resolveZone(settings)).toLowerCase()}.`,
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
      const blockUntilMs = args.block_until_ms == null ? 30_000 : Number(args.block_until_ms);
      const job = await bgShell.startShell({
        botId: bot.id,
        command: cmd,
        blockUntilMs,
        run: async (c) => {
          const r = await vm.shell(bot as AgentDeskBot, c);
          return { ok: r.ok, output: vault.redactSecrets(r.output || (r.ok ? "(ok)" : "(failed)"), secrets) };
        },
      });
      bgShell.attachToBot(bot, job);
      if (job.background) return { text: JSON.stringify(job) };
      return { text: job.output || JSON.stringify(job) };
    }
    if (name === "computer") {
      if (isHumanControl(bot.id)) {
        return {
          text: "The human has the mouse. Do not click, type, or move. Wait or reply in chat.",
        };
      }
      return computerAction(bot as AgentDeskBot, args, emit);
    }
    if (name === "request_box_help") {
      const row = requestBoxHelp(bot.id, { reason: args.reason || args.message || args.content });
      emit("control", { botId: bot.id, requestBoxHelp: true, reason: row.reason });
      bot.awaitingUserSelection = true;
      endTurnKeepBot(bot.id);
      return {
        text: JSON.stringify({
          ok: true,
          action: "take_control",
          reason: row.reason,
          hostFs: false,
        }),
        endTurn: true,
      };
    }
    if (name === "update_state") {
      const r = await handleUpdateState(bot, args, {});
      if (r.persist) await store.upsertBot(bot);
      return { text: r.text };
    }
    if (name === "read") {
      const r = await readFile({ path: args.path, bot });
      // `!`: `readFile` always carries `text` on a `kind: "text"` result; the
      // result type does not discriminate on `kind`.
      // Same sweep gap as `memory` above.
      const secrets = await vault.listSecrets();
      if (r.kind === "text") return { text: vault.redactSecrets(r.text!, secrets) };
      return { text: vault.redactSecrets(`${r.kind}: ${r.path}`, secrets) };
    }
    if (name === "web_fetch") {
      const r = await webFetch(args.url);
      return { text: r.text || "" };
    }
    if (name === "create_channel") {
      const row = await channels.createChannel({
        name: args.name,
        memberIds: args.member_ids || args.memberIds || [bot.id],
        description: args.description,
      });
      // The tool description promises "Writes group.json", but only the HTTP
      // routes did it -- a room made by a bot never got the desk-side mirror,
      // so isChannel() was false for it. Fire-and-forget, as the routes do.
      syncChannelDesk(row);
      return { text: JSON.stringify(row) };
    }
    if (name === "update_channel") {
      const id = args.channel_id || args.channelId;
      if (args.add_id) {
        const row = await channels.addMember(id, args.add_id);
        syncChannelDesk(row);
        return { text: JSON.stringify(row) };
      }
      if (args.remove_id) {
        const row = await channels.removeMember(id, args.remove_id);
        syncChannelDesk(row);
        return { text: JSON.stringify(row) };
      }
      return { text: "pass add_id or remove_id" };
    }
    if (name === "task") {
      const row = await subagents.spawn({
        botId: bot.id,
        type: args.type || "executor",
        prompt: args.prompt,
        display: bot.vm?.display,
        computerId: bot.vm?.computerId,
        container: bot.vm?.container,
        harnessUrl: deskClient.harnessUrlFor(bot),
        harnessToken: settings?.__internalToken || "",
      });
      return { text: JSON.stringify(row) };
    }
    if (name === "check_subagent") {
      if (args.id) {
        const row = await subagents.get(args.id, bot.id);
        return { text: row ? JSON.stringify(row) : "not found" };
      }
      return { text: JSON.stringify(await subagents.list(bot.id)) };
    }
    if (name === "message_subagent") {
      // `as string` here and in the cloud_agent / MCP branches below: each tool
      // schema marks the id required, and each callee answers "not found" for one
      // it cannot match. The declared `string` is the callee's claim, not this
      // file's — a call that omits the id is a wire error, not a crash.
      return { text: JSON.stringify(await subagents.message(args.id as string, args.message, bot.id)) };
    }
    if (name === "stop_subagent") {
      return { text: JSON.stringify(await subagents.stop(args.id as string, bot.id)) };
    }
    if (name === "cloud_agent") {
      const action = String(args.action || "");
      if (action === "launch") return { text: JSON.stringify(await codeAgent.launchCodeAgent(bot, args)) };
      if (action === "list") return { text: JSON.stringify(await codeAgent.listCodeAgents(bot)) };
      if (action === "get") return { text: JSON.stringify(await codeAgent.getCodeAgent(bot, args.id as string)) };
      if (action === "reply") return { text: JSON.stringify(await codeAgent.replyCodeAgent(bot, args.id as string, args.message || args.content)) };
      if (action === "cancel") return { text: JSON.stringify(await codeAgent.cancelCodeAgent(bot, args.id as string)) };
      if (action === "delete") return { text: JSON.stringify(await codeAgent.deleteCodeAgent(bot, args.id as string)) };
      return { text: `unknown action ${action}` };
    }
    if (name === "await_shell") {
      const job = (await bgShell.awaitShell(args.id, bot.id)) || (bot.backgroundShells || []).find((j) => !args.id || j.id === args.id);
      if (job) bgShell.attachToBot(bot, job);
      return { text: job ? JSON.stringify(job) : "no background shell" };
    }
    if (name === "add_mcp_server") {
      const row = await mcpRemote.addServer({ name: args.name, url: args.url, headers: args.headers });
      return { text: JSON.stringify(row) };
    }
    if (name === "get_mcp_tools") {
      const out = await mcpRemote.getMcpTools(args.server_id as string);
      if (out.needsAuth) return { text: "needsAuth — call authenticate_mcp_server" };
      return { text: JSON.stringify(out) };
    }
    if (name === "call_mcp_tool") {
      const out = await mcpRemote.callMcpTool(args.server_id as string, args.tool, args.arguments || args.args);
      if (out.needsAuth) return { text: "needsAuth — call authenticate_mcp_server" };
      return { text: JSON.stringify(out.result ?? out) };
    }
    if (name === "authenticate_mcp_server") {
      const row = await mcpRemote.getServer(args.server_id as string);
      if (!row) return { text: "server not found" };
      // `as unknown as AgentMessage`: same as ask_user above — `connectCard`
      // always answers a `type: "secret-request"` spec, which always builds.
      const card = cardFromSendMessageArgs(bot, mcpRemote.connectCard(bot, row)) as unknown as AgentMessage;
      bot.messages.push(card);
      bot.awaitingUserSelection = true;
      await store.patchBot(bot.id, (b) => {
        b.messages = b.messages || [];
        if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card);
        b.awaitingUserSelection = true;
      });
      await Promise.resolve(emit("message", card));
      endTurnKeepBot(bot.id);
      return { text: "asked the user to connect; wait for the masked field", endTurn: true };
    }
    return { text: `unknown tool ${name}` };
  } catch (err) {
    // `as Error`: this file only ever reads `.message` off a caught value, the
    // same way vm.mts does. A non-Error rejection renders as `undefined` here
    // exactly as it did before.
    return { text: `error: ${(err as Error).message}` };
  }
}

const lastShotAt = new Map<string, number>();

async function computerAction(bot: AgentDeskBot, args: ToolArgs, emit: Emit): Promise<ToolResult> {
  const action = args.action;
  // `as string`: a call with no action is one the model malformed; it falls
  // through to the "unknown computer action" reply at the bottom either way.
  const needsAim = ["left_click", "right_click", "double_click", "left_click_drag", "scroll"].includes(action as string);
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

export async function webSearch(settings: AgentSettings | null | undefined, query: unknown): Promise<string> {
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
    // `as Error`: only `.name` and `.message` are read, both with a fallback.
    const name = (err as Error)?.name || "Error";
    if (name === "TimeoutError" || name === "AbortError") {
      return "web_search failed (timeout): SpaceXAI web_search took too long. Try a narrower query.";
    }
    // `as Error`: `name` above already read `.name` off the same value; this
    // reads `.message` the same way, and falls back when there is none.
    return `web_search failed: ${(err as Error).message || name}`;
  }
  // `as SearchResponse`: node's fetch types `json()` as `unknown`, and the two
  // readers below already treat every level of it as untrusted.
  const json = await res.json().catch(() => ({})) as SearchResponse;
  if (!res.ok) {
    const err = json.error?.message || json.error || res.statusText;
    return `web_search failed (${res.status}): ${typeof err === "string" ? err : JSON.stringify(err)}`;
  }
  const text = extractResponseText(json);
  const cites = collectCitations(json);
  if (!text && !cites.length) return JSON.stringify(json).slice(0, 2000);
  return cites.length ? `${text}\n\nSources:\n${cites.map((c) => `- ${c}`).join("\n")}` : text;
}

function extractResponseText(json: SearchResponse): string {
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

function collectCitations(json: SearchResponse): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: unknown): void => {
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

function recapForGrok(bot: AgentBot): string {
  return hostCli.recapConversation(bot.messages);
}

async function grokSessionOnDisk(box: string, sessionId: string): Promise<boolean> {
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

function summarizeVmCommand(cmd: unknown = ""): { name: string; action: string; summary: string } {
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

function emitGrokToolActivity(bot: AgentBot, emit: Emit | undefined, seen: Set<string>, evt: GrokEvent): void {
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

function runGrokBuild(
  harness: HostHarness,
  userText: string,
  signal: AbortSignal | undefined,
  bot: AgentBot,
  emit?: Emit | undefined,
  { settings, hidden = false }: { settings?: AgentSettings | undefined; hidden?: boolean | undefined } = {},
): Promise<string> {
  const box = bot?.vm?.container || (bot?.id ? vm.containerName(bot.id) : "");
  if (!box) {
    return Promise.resolve(
      "Grok Build only runs inside a bot computer. Start the computer first.",
    );
  }
  const sessionId = hostCli.cliSessionId(bot) || bot.id;
  bot.grokSessionId = sessionId;
  bot.harnessSessionId = sessionId;
  return (async () => {
    try {
      await vm.pushHostGrokAuth(box);
    } catch {
      /* still try */
    }
    const signed = await vm.grokSignedIn(box);
    if (!signed.ok) {
      emit?.("harness-auth", { provider: "grok-build" });
      return "Grok Build is signed out. Open Settings → Harness → Grok Build and sign in, then send this again.";
    }
    const extra = await ctx.agentsExtra({ bot, settings, hidden });
    await vm.installAgentsMd(box, extra);
    const caps = await ctx.readPrompt("capabilities.txt");
    const rules = `${await fs.readFile(path.join(appRoot, "prompts", "grok-build-vm.txt"), "utf8")}\n${caps}\n${extra}\n`;
    const exists = !bot.harnessSessionFresh && (await grokSessionOnDisk(box, sessionId));
    if (bot.harnessSessionFresh) bot.harnessSessionFresh = false;
    const recap = exists ? "" : recapForGrok(bot);
    const prompt = hostCli.continuePrompt(userText, recap);
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
      "--effort",
      "low",
      "--no-alt-screen",
      "--output-format",
      "streaming-json",
      "--rules",
      rules,
    );
    return new Promise<string>((resolve) => {
      const inner = harness.command === "grok" || !harness.command ? "/usr/local/bin/grok" : harness.command;
      const args = [
        "exec",
        "-u",
        "abc",
        "-e",
        "HOME=/config",
        "-e",
        `DISPLAY=${bot.vm?.display || ":1"}`,
        "-e",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        ...vm.workEnvArgs(bot.id),
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
      const seenTools = new Set<string>();
      let done = false;
      const IDLE_MS = 180_000;
      const HARD_MS = 20 * 60_000;
      let idleTimer: NodeJS.Timeout | null = null;
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
      const finish = (text: string): void => {
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
      const takeLine = (line: unknown): void => {
        const raw = String(line || "").trim();
        if (!raw) return;
        if (raw[0] !== "{") {
          tail = raw.slice(-400);
          return;
        }
        let evt: GrokEvent;
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
      const onChunk = (chunk: Buffer | string): void => {
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
      // `!` twice: `vm.dockerSpawn` leaves stdio at its default, so both pipes
      // are there. They are only null when a caller asks for "ignore"/"inherit".
      child.stdout!.on("data", onChunk);
      child.stderr!.on("data", onChunk);
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
