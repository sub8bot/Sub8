/** Cloud chat uses the same runTurn + vm.mjs loop as Local. Desk-agent is only docker-exec over HTTP. */
import { runTurn } from "../agent.mjs";
import { setHumanControl } from "@sub8/control";
import * as vm from "../vm.mjs";
import { cloudBaseUrl, useMockAuth } from "./env.mjs";
import * as http from "./http.mjs";
import type { RunTurnOptions } from "../agent.mjs";

/**
 * One row of a Cloud thread, as this file moves it between the Worker's KV
 * store and the agent loop. Every field is optional and the index signature
 * stays open on purpose: the rows are whatever an older build wrote, and every
 * read below already defaults what it needs.
 */
export interface ChatMessage {
  id?: string | undefined;
  role?: string | undefined;
  content?: string | undefined;
  ts?: number | undefined;
  kind?: string | undefined;
  [key: string]: unknown;
}

/**
 * The /api/brain/runtime fields this file reads. cloudApi answers with an open
 * CloudBody whose every value is `unknown`, so the module that knows what this
 * endpoint returns is the one that says so. A type alias rather than an
 * interface: only an object-literal type carries the implicit index signature
 * that makes the erase-only assertion in liveBrainRuntime legal against
 * CloudBody.
 */
export type BrainRuntime = {
  provider?: string | undefined;
  secret?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  ipv4?: string | undefined;
  deskToken?: string | undefined;
  human?: unknown;
  messages?: ChatMessage[] | undefined;
};

/** The /api/brain/thread body, for the same reason as BrainRuntime. */
export type BrainThread = {
  messages?: ChatMessage[] | undefined;
};

/** Bearer token for the signed-in Cloud session, and the desk it addresses. */
export interface ComputerIdOptions {
  token?: string | undefined;
  computerId?: string | undefined;
}

export interface SaveThreadOptions extends ComputerIdOptions {
  messages?: ChatMessage[] | undefined;
  botId?: string | undefined;
}

export interface ThreadOptions extends ComputerIdOptions {
  botId?: string | undefined;
}

export interface AppendCloudUserOptions extends ThreadOptions {
  content?: string | undefined;
}

export interface RunCloudTurnOptions extends AppendCloudUserOptions {
  signal?: AbortSignal | undefined;
  /** Widest shape every caller satisfies; the runtime check below still gates it. */
  emit?: ((event: unknown) => void) | undefined;
  persistUser?: boolean | undefined;
  display?: unknown;
}

function needBase(): string {
  const base = cloudBaseUrl();
  if (!base || base === "mock") {
    // Same shape as cloud/http.mts throws: a plain Error with the Cloud fields
    // stapled on, which is what the desktop UI reads. The assertion emits nothing.
    const err = new Error("Cloud sign-in is not configured.") as http.CloudError;
    err.code = "NO_CLOUD";
    throw err;
  }
  return base;
}

export async function liveBrainRuntime({ token, computerId }: ComputerIdOptions = {}): Promise<BrainRuntime> {
  if (useMockAuth()) {
    const err = new Error("Mock Cloud has no live desks.") as http.CloudError;
    err.code = "CLOUD";
    throw err;
  }
  // Erase-only: cloudApi hands back CloudBody, which types every value
  // `unknown`. Nothing about the request changes.
  return http.cloudApi(`/api/brain/runtime?computerId=${encodeURIComponent(computerId || "")}`, {
    baseUrl: needBase(),
    token,
  }) as Promise<BrainRuntime>;
}

export async function liveBrainSaveThread({ token, computerId, messages, botId }: SaveThreadOptions = {}) {
  return http.cloudApi("/api/brain/thread", {
    baseUrl: needBase(),
    token,
    method: "PUT",
    body: { computerId, messages, botId },
  });
}

function displayOf(display: unknown): string {
  if (display == null || display === "") return ":1";
  const s = String(display).trim();
  if (!s) return ":1";
  return s.startsWith(":") ? s : `:${s}`;
}

function isChiefBotId(botId: string | undefined, computerId: string): boolean {
  const b = String(botId || "").trim();
  const chief = `cloud-${computerId}`;
  return !b || b === "default" || b === chief || b === computerId;
}

export function chatMessages(messages: readonly ChatMessage[] | null | undefined): ChatMessage[] {
  return (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .filter((m) => m.kind !== "tool" && m.kind !== "activity" && m.kind !== "think")
    .filter((m) => !/You've got the computer|You're done driving/i.test(String(m.content)))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: String(m.content),
      ts: m.ts || Date.now(),
    }))
    .slice(-80);
}


export function mergeChat(a: readonly ChatMessage[] | null | undefined, b: readonly ChatMessage[] | null | undefined): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const m of chatMessages([...(a || []), ...(b || [])])) {
    const key = m.id || `${m.role}:${m.ts}:${String(m.content).slice(0, 48)}`;
    if (!map.has(key)) map.set(key, m);
  }
  return [...map.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0)).slice(-80);
}

async function loadThread({ token, computerId, botId }: ThreadOptions): Promise<BrainThread> {
  const q = new URLSearchParams({ computerId: computerId || "" });
  if (botId) q.set("botId", botId);
  // Erase-only, same reasoning as liveBrainRuntime.
  return http.cloudApi(`/api/brain/thread?${q}`, {
    baseUrl: needBase(),
    token,
  }) as Promise<BrainThread>;
}

export async function appendCloudUser({ token, computerId, content, botId }: AppendCloudUserOptions = {}) {
  const id = String(computerId || "").replace(/^cloud[:-]/, "");
  if (!id) {
    const err = new Error("No Cloud computer.") as http.CloudError;
    err.status = 422;
    throw err;
  }
  const text = String(content || "").trim();
  if (!text) {
    const err = new Error("Message is empty.") as http.CloudError;
    err.status = 422;
    throw err;
  }
  const resolvedBotId = botId || `cloud-${id}`;
  const runtime = await liveBrainRuntime({ token, computerId: id });
  const stored = await loadThread({ token, computerId: id, botId: resolvedBotId }).catch(() => null);
  const seed = stored?.messages ?? (isChiefBotId(resolvedBotId, id) ? runtime.messages : []);
  const user = { id: `u${Date.now()}`, role: "user", content: text, ts: Date.now() };
  const messages = mergeChat(seed, [user]);
  await liveBrainSaveThread({ token, computerId: id, botId: resolvedBotId, messages });
  return { user, messages };
}

export async function runCloudTurn({ token, computerId, content, signal, emit, persistUser = true, botId, display }: RunCloudTurnOptions = {}) {
  const id = String(computerId || "").replace(/^cloud[:-]/, "");
  if (!id) {
    const err = new Error("No Cloud computer.") as http.CloudError;
    err.status = 422;
    throw err;
  }
  const runtime = await liveBrainRuntime({ token, computerId: id });
  if (runtime.provider === "claude") {
    const err = new Error("Claude on Cloud is key-only chat for now. Use Grok to drive the desk.") as http.CloudError;
    err.status = 409;
    err.code = "CLAUDE_CHAT";
    throw err;
  }
  if (!runtime.secret) {
    const err = new Error("Connect a brain first. Sign in with Grok, or paste an API key.") as http.CloudError;
    err.status = 409;
    err.code = "NEED_BRAIN";
    throw err;
  }
  if (!runtime.ipv4 || !runtime.deskToken) {
    const err = new Error("This Cloud desk is not wired for control yet.") as http.CloudError;
    err.status = 409;
    err.code = "NO_DESK";
    throw err;
  }
  const resolvedBotId = botId || `cloud-${id}`;
  const stored = await loadThread({ token, computerId: id, botId: resolvedBotId }).catch(() => null);
  const seed = stored?.messages ?? (isChiefBotId(resolvedBotId, id) ? runtime.messages : []);
  let botName = "Bot";
  try {
    const team = (await http.cloudApi(`/api/brain/team?computerId=${encodeURIComponent(id)}`, {
      baseUrl: needBase(),
      token,
    })) as { name?: string; members?: { id?: string; name?: string }[] };
    const mate = (team.members || []).find((m) => m.id === resolvedBotId);
    botName = String(mate?.name || team.name || "").trim() || "Bot";
  } catch {
    /* keep Bot */
  }
  const bot = {
    id: resolvedBotId,
    name: botName,
    computerId: id,
    place: "cloud",
    // Erase-only. agent.mts requires an `id` on every row it is handed; a Cloud
    // thread row that arrived without one has always flowed through here
    // unchanged, and this keeps it flowing rather than dropping or minting one.
    messages: chatMessages(seed) as RunTurnOptions["bot"]["messages"],
    routines: [],
    harness: { provider: "spacexai", model: runtime.model || "grok-4.6" },
    vm: {
      kind: "cloud",
      computerId: id,
      status: "running",
      display: displayOf(display),
      deskUrl: `http://${runtime.ipv4}:3001`,
      deskToken: runtime.deskToken,
    },
  };
  setHumanControl(resolvedBotId, Boolean(runtime.human));
  const settings = {
    harness: {
      provider: "spacexai",
      model: runtime.model || "grok-4.6",
      apiKey: runtime.secret,
      baseUrl: runtime.baseUrl || "https://api.x.ai/v1",
    },
  };
  let images: string[] = [];
  if (!runtime.human) {
    try {
      const shot = await vm.screenshot(bot);
      if (shot?.buf) images = [shot.buf.toString("base64")];
    } catch (err) {
      console.error("cloud desk screenshot", (err as Error).message);
    }
  }
  try {
    await runTurn({
      bot,
      settings,
      userText: String(content || ""),
      images,
      signal,
      persistUser,
      emit: typeof emit === "function" ? emit : () => {},
    });
  } finally {
    const latest = await loadThread({ token, computerId: id, botId: resolvedBotId }).catch(() => ({ messages: [] }));
    await liveBrainSaveThread({
      token,
      computerId: id,
      botId: resolvedBotId,
      messages: mergeChat(bot.messages, latest.messages),
    }).catch((err) => console.error("cloud save thread", err.message));
  }
  const saved = await loadThread({ token, computerId: id, botId: resolvedBotId }).catch(() => ({ messages: bot.messages }));
  const last = [...(saved.messages || bot.messages)]
    .reverse()
    .find((m) => m.role === "assistant" && String(m.content || "").trim());
  return {
    reply: last || { role: "assistant", content: "Done.", ts: Date.now() },
    messages: saved.messages || bot.messages,
  };
}
