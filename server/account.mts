import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";
import { writeJsonAtomic } from "@sub8/store";
import {
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  requireAccount,
  startMagic as cloudStartMagic,
  startX as cloudStartX,
  waitX as cloudWaitX,
  useMockAuth,
  liveComputers as cloudLiveComputers,
  liveCreateComputer as cloudLiveCreate,
  liveDestroyComputer as cloudLiveDestroy,
  liveBrain as cloudLiveBrain,
  liveBrainStartGrok as cloudLiveBrainStartGrok,
  liveBrainClaudeAuth as cloudLiveBrainClaudeAuth,
  liveBrainPlugins as cloudLiveBrainPlugins,
  getCloudVault as cloudGetVault,
  gateStatus as cloudGateStatus,
  gateSetup as cloudGateSetup,
  gateUnlock as cloudGateUnlock,
  gateReset as cloudGateReset,
  putCloudVault as cloudPutVault,
  deleteCloudVault as cloudDeleteVault,
  getCloudEscrowKey as cloudGetEscrowKey,
  putCloudEscrowKey as cloudPutEscrowKey,
  liveBrainClaudeAuthStart as cloudLiveBrainClaudeAuthStart,
  liveBrainClaudeAuthCode as cloudLiveBrainClaudeAuthCode,
  liveBrainClaudeAuthLogout as cloudLiveBrainClaudeAuthLogout,
  liveBrainClaudeForget as cloudLiveBrainClaudeForget,
  liveBrainWaitGrok as cloudLiveBrainWaitGrok,
  liveBrainKey as cloudLiveBrainKey,
  liveBrainRoutines as cloudLiveBrainRoutines,
  liveBrainRoutineCreate as cloudLiveBrainRoutineCreate,
  liveBrainRoutinePatch as cloudLiveBrainRoutinePatch,
  liveBrainRoutineDelete as cloudLiveBrainRoutineDelete,
  liveBrainThread as cloudLiveBrainThread,
  liveBrainChat as cloudLiveBrainChat,
  liveBrainControl as cloudLiveBrainControl,
  liveBrainTeam as cloudLiveBrainTeam,
  liveBrainCreateMate as cloudLiveCreateMate,
  liveBrainPatchMate as cloudLivePatchMate,
  liveDeskAction as cloudLiveDeskAction,
  liveBrainDeleteMate as cloudLiveDeleteMate,
  liveBrainTurn as cloudLiveBrainTurn,
  liveBrainAbort as cloudLiveBrainAbort,
  liveBrainSetModel as cloudLiveBrainSetModel,
  liveBillingSummary as cloudLiveBillingSummary,
  liveBillingPortal as cloudLiveBillingPortal,
  liveBillingCheckout as cloudLiveBillingCheckout,
  revokeSession as cloudRevokeSession,
  getVaultFillPending as cloudVaultFillPending,
  approveVaultFill as cloudVaultFillApprove,
  denyVaultFill as cloudVaultFillDeny,
  liveMe as cloudLiveMe,
  requestCloudAccess as cloudRequestAccess,
} from "./cloud/index.mjs";
import { runCloudTurn as cloudRunTurn, appendCloudUser as cloudAppendUser, liveBrainSaveThread as cloudSaveThread, chatMessages } from "./cloud/turn.mjs";

/**
 * Every throw below is a plain Error with `code` — and sometimes `status` —
 * stapled on, which the desktop UI reads back off `err.code`. Same shape
 * cloud/http.mts throws, and `new Error(...) as CloudError` rather than a
 * subclass for the same reason: a subclass would change the thrown value.
 * The assertion emits nothing.
 */
import type { CloudError } from "./cloud/http.mjs";

export {
  accountEnabled,
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  isPackaged,
  requireAccount,
  useMockAuth,
} from "./cloud/index.mjs";

/** Where the account lives. `normalize` collapses anything else to null. */
export type AccountPlace = "local" | "cloud";

/** Which side the desktop is showing. Never "cloud" without a live session. */
export type AccountView = "local" | "cloud";

/**
 * The signed-in session as `data/account.json` holds it. Four fields are
 * strings because `normalize` coerces each one before writing; `expiresAt` is
 * whatever the Worker (or an older build) put there and is only ever read
 * back through `Number()`, so it stays `unknown`.
 */
export interface AccountSession {
  email: string;
  handle: string;
  userId: string;
  token: string;
  expiresAt: unknown;
  /** X profile photo URL from the Worker session, or "". */
  photo: string;
  cloudAccess: boolean;
  admin: boolean;
}

/** One `data/account.json`, after `normalize`. */
export interface AccountRow {
  version: number;
  place: AccountPlace | null;
  view: AccountView;
  inferred: boolean;
  cloudPromptDismissed: boolean;
  session: AccountSession | null;
  updatedAt: number;
}

/** An AccountRow `sessionLive` has already proved carries a session. */
export type LiveAccountRow = AccountRow & { session: AccountSession };

/**
 * What `normalize` and `saveAccount` accept: an account.json an older build
 * wrote, a half-built row from a caller, or a session the Cloud Worker just
 * handed back. Every field is a claim, so every field is `unknown` and
 * `normalize` is the one place that coerces it.
 */
export interface AccountSessionInput {
  email?: unknown;
  handle?: unknown;
  userId?: unknown;
  token?: unknown;
  expiresAt?: unknown;
  photo?: unknown;
  cloudAccess?: unknown;
  admin?: unknown;
}

export interface AccountRowInput {
  version?: unknown;
  place?: unknown;
  view?: unknown;
  inferred?: unknown;
  cloudPromptDismissed?: unknown;
  session?: AccountSessionInput | null | undefined;
  updatedAt?: unknown;
}

/** `completeSession`'s argument: an X-wait body, or a request body from the UI. */
export interface SessionPayload {
  handle?: unknown;
  email?: unknown;
  token?: unknown;
  userId?: unknown;
  expiresAt?: unknown;
  photo?: unknown;
  cloudAccess?: unknown;
  admin?: unknown;
}

export interface LoadAccountOptions {
  hasLocalBots?: boolean | undefined;
}

/** What `decideGate` is told about the rest of the app. */
export interface GateOptions {
  requireAccount?: boolean | undefined;
  hasLocalBots?: boolean | undefined;
}

/** The sign-in gate the desktop renders. `publicAccount` mutates its own copy. */
export interface AccountGate {
  ready: boolean;
  needsChoice: boolean;
  needsCloudPrompt: boolean;
  requireAccount: boolean;
  hideLocal: boolean;
  place: AccountPlace | null;
  view: AccountView;
  signedIn: boolean;
  inferred: boolean;
  cloudEnabled: boolean;
  cloudPromptDismissed: boolean;
  email: string | null;
  handle: string | null;
  userId: string | null;
  /** X profile photo URL when signed in with one; the desktop falls back to an identicon. */
  photoUrl: string | null;
}

/** An AccountGate plus the build-level flags. What `/api/account` answers. */
export interface PublicAccount extends AccountGate {
  enabled: boolean;
  mockAuth: boolean;
  cloudConfigured: boolean;
  comingSoon: boolean;
  cloudProduct: boolean;
  xLogin: boolean;
  cloudAccess: boolean;
}

/**
 * The Cloud Worker bodies this file reads. `cloudApi` answers with an open
 * `CloudBody` whose every value is `unknown`, so the module that knows what an
 * endpoint returns is the one that says so. Each of these is only ever the
 * annotation on the `const` the call already assigns to — never a cast.
 */
export interface LiveComputer {
  id?: string | undefined;
  userId?: string | undefined;
  status?: string | undefined;
  sku?: string | undefined;
  ipv4?: string | undefined;
  streamUrl?: string | undefined;
  error?: string | undefined;
  [key: string]: unknown;
}

/** `GET /api/computers`. */
export interface LiveComputersBody {
  computers?: LiveComputer[] | undefined;
  [key: string]: unknown;
}

/** `POST /api/computers` answers either `{ computer }` or the computer itself. */
export interface CreatedComputer extends LiveComputer {
  computer?: LiveComputer | undefined;
}

/** `GET /api/brain`. `connected` alone is what the failure path substitutes. */
export interface CloudBrain {
  claudeModel?: string | undefined;
  grokModel?: string | undefined;
  connected?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  grokSignedIn?: unknown;
  apiKeySet?: unknown;
  [key: string]: unknown;
}

/** One row of `GET /api/brain/team`'s `members`. */
export interface CloudTeamMember {
  /** A user photo (data URL) shown instead of the drop avatar. */
  photo?: string | undefined;
  id: string;
  name?: string | undefined;
  color?: string | undefined;
  job?: string | undefined;
  role?: string | undefined;
  display?: unknown;
  identityId?: string | undefined;
  [key: string]: unknown;
}

/** `GET /api/brain/team`. */
export interface CloudTeamBody {
  members?: CloudTeamMember[] | undefined;
  name?: string | undefined;
  job?: string | undefined;
  [key: string]: unknown;
}

/** `GET /api/brain/thread`. The rows stay `unknown`: this file only moves them. */
export interface CloudThreadBody {
  messages?: unknown[] | undefined;
  [key: string]: unknown;
}

/**
 * What `cloud/index.mts`'s `startX` answers. The mock backend signs in on the
 * spot and returns a `session`; the live one returns an authorize URL and a
 * state to poll. The union those two infer to keeps only the live half, so the
 * caller has to say that `session` is a field either can carry.
 */
export interface CloudStartX {
  session?: AccountSessionInput | undefined;
  authorizeUrl?: string | undefined;
  state?: string | undefined;
  /** Shown to the user; the browser's confirm page asks for it. */
  code?: string | undefined;
  signedIn?: boolean | undefined;
  mock?: boolean | undefined;
}

/** `POST /api/brain/team`. */
export interface CreateMateBody {
  bot?: { id?: string | undefined } | undefined;
  created?: unknown;
  [key: string]: unknown;
}

/** A Cloud desk as the desktop lists it. `mapLiveComputer` is the only builder. */
export interface CloudDesk {
  id: string | undefined;
  name: string;
  kind: string;
  status: string | undefined;
  sku: string;
  ram: string;
  region: string;
  ipv4: string;
  streamUrl: string;
  error: string;
  draft: boolean;
  attachedBotId: string | null;
  attachedBotName: string | null;
}

export interface CloudBotAvatar {
  expression: string;
  animation: string;
  body: string;
  color: string;
}

/** `signedIn`/`apiKeySet` are absent until a live `/api/brain` fills them in. */
export interface CloudBotHarness {
  provider: string;
  model: string;
  signedIn?: boolean | undefined;
  apiKeySet?: boolean | undefined;
}

export interface CloudBotVm {
  kind: string;
  computerId: string | undefined;
  status: string;
  hint: string | undefined;
  streamUrl: string;
  display: string;
}

/**
 * A Cloud desk presented as a bot. `messages` stays `unknown[]`: this file
 * carries thread rows between the Worker and the client without reading one.
 */
export interface CloudBot {
  id: string;
  name: string;
  color: string;
  description: string;
  instructions: string;
  avatar: CloudBotAvatar;
  harness: CloudBotHarness;
  identityId?: string | undefined;
  messages: unknown[];
  routines: unknown[];
  computerId: string | undefined;
  place: string;
  draft: boolean;
  teamId?: string | undefined;
  teamRole?: string | undefined;
  vm: CloudBotVm;
  desk: CloudDesk;
  brain?: CloudBrain | undefined;
  messagesFailed?: boolean | undefined;
}

/** One Cloud team, assembled from the bots that carry the same `teamId`. */
export interface CloudTeam {
  id: string;
  name: string;
  chiefId: string | undefined;
  memberIds: string[];
  job: string | null;
}

/** What the last `liveSnapshot` remembered, for the cheap thread-tail poll. */
export interface SnapshotBotRef {
  id: string;
  computerId: string;
}

export interface ThreadTail {
  botId: string;
  messages: unknown[] | null;
  messagesFailed: boolean;
}

/** One full Cloud refresh. `teams` is absent on the signed-out early return. */
export interface LiveSnapshot {
  computers: CloudDesk[];
  bots: CloudBot[];
  brain: CloudBrain;
  teams?: CloudTeam[] | undefined;
}

/** `cloudMessageIdentity`'s body: a route payload, so both fields are claims. */
export interface CloudMessageBody {
  computerId?: unknown;
  botId?: unknown;
}

export interface CloudMessageIdentity {
  computerId: string;
  botId: string;
}

export interface ProbeStreamOptions {
  computerId?: string | undefined;
  display?: unknown;
}

export interface StreamProbe {
  ok: boolean;
  reason?: string | undefined;
  status?: number | undefined;
}

/** The desk every Cloud verb below addresses. */
export interface DeskOptions {
  computerId?: string | undefined;
}

export interface BrainKeyBody {
  provider?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export interface RoutineOptions extends DeskOptions {
  id?: string | undefined;
  name?: string | undefined;
  instruction?: string | undefined;
  intervalMinutes?: number | undefined;
  enabled?: boolean | undefined;
  botId?: string | undefined;
}

export interface MateOptions extends DeskOptions {
  botId?: string | undefined;
  name?: string | undefined;
  job?: string | undefined;
  identityId?: string | undefined;
  /** A user photo (data URL); "" clears it. */
  photo?: string | undefined;
  /** The drawn look. */
  avatar?: { body?: string; expression?: string; animation?: string } | undefined;
}

export interface ChatOptions extends DeskOptions {
  content?: string | undefined;
  botId?: string | undefined;
  display?: unknown;
  persistUser?: boolean | undefined;
  identityId?: string | undefined;
}

export interface TurnOptions extends DeskOptions {
  id?: string | undefined;
}

export interface AbortOptions extends DeskOptions {
  turnId?: string | undefined;
  all?: unknown;
}

/** `liveCloudTurn` is `liveBrainChat` plus the abort signal of the local run. */
export interface CloudTurnOptions extends ChatOptions {
  signal?: AbortSignal | undefined;
}

export interface CloudAppendOptions extends DeskOptions {
  content?: string | undefined;
  botId?: string | undefined;
}

export interface BrainControlOptions extends DeskOptions {
  on?: unknown;
}

export const CHAT_TEAM = {
  error: "Cloud teammates live on the desk, not the local draft store.",
  code: "CHAT_TEAM",
};

/** True when live Cloud is on — the local draft store must not be written. */
export function liveDraftBotCrudBlocked(): boolean {
  return !useMockAuth();
}

function liveDeskId(computerId: unknown, botId?: unknown): string {
  let id = String(computerId || "").trim();
  if (id.startsWith("cloud-") || id.startsWith("cloud:")) {
    id = cloudMessageIdentity({}, id).computerId;
  }
  if (!id && botId) id = cloudMessageIdentity({}, botId).computerId;
  return id;
}

export const accountPath = (): string => path.join(dataDir, "account.json");

export function normalizeEmail(raw: unknown): string {
  const email = String(raw || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function blank(): AccountRow {
  return {
    version: 1,
    place: null,
    view: "local",
    inferred: false,
    cloudPromptDismissed: false,
    session: null,
    updatedAt: 0,
  };
}

function normalize(raw: AccountRowInput | null | undefined): AccountRow {
  const base = blank();
  if (!raw || typeof raw !== "object") return base;
  const place = raw.place === "local" || raw.place === "cloud" ? raw.place : null;
  const rawSession = raw.session && typeof raw.session === "object" ? raw.session : null;
  const handle = String(rawSession?.handle || "").trim();
  const email = String(rawSession?.email || (handle ? `${handle}@x.local` : "")).trim();
  const token = String(rawSession?.token || "").trim();
  const session =
    rawSession && (email || handle || token)
      ? {
          email,
          handle,
          userId: String(rawSession.userId || ""),
          token,
          expiresAt: rawSession.expiresAt || null,
          photo: String(rawSession.photo || "").trim(),
          cloudAccess: Boolean(rawSession.cloudAccess || rawSession.admin),
          admin: Boolean(rawSession.admin),
        }
      : null;
  const view = raw.view === "cloud" || raw.view === "local" ? raw.view : place === "cloud" ? "cloud" : "local";
  return {
    version: 1,
    place,
    view: view === "cloud" && !session ? "local" : view,
    inferred: Boolean(raw.inferred),
    cloudPromptDismissed: Boolean(raw.cloudPromptDismissed),
    session,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

const SKU_RAM: Record<string, string> = {
  "vm.1g": "1 GB",
  "vm.2g": "2 GB",
  "vm.4g": "4 GB",
  "vm.8g": "8 GB",
  "vm.16g": "16 GB",
};

export function cloudBotId(computerId: unknown): string {
  const id = String(computerId || "").replace(/^cloud[:-]/, "");
  return id ? `cloud-${id}` : "";
}

/** Chief plus selected teammate, plus any extra ids already keyed to this desk. */
export function cloudDeskBotIds(computerId: unknown, selectedId: unknown, extraIds: readonly unknown[] = []): string[] {
  const chief = cloudBotId(computerId);
  const ids = new Set<string>();
  if (chief) ids.add(chief);
  const selected = String(selectedId || "").trim();
  if (selected) ids.add(selected);
  const prefix = chief ? `${chief}-` : "";
  for (const id of extraIds) {
    const botId = String(id || "").trim();
    if (!botId) continue;
    if (botId === chief || (prefix && botId.startsWith(prefix))) ids.add(botId);
  }
  return [...ids];
}

/** Prefer body computerId/botId. Else strip cloud- from the route id. */
export function cloudMessageIdentity(body: CloudMessageBody = {}, paramId: unknown = ""): CloudMessageIdentity {
  const computerId = String(body.computerId || "").trim();
  const hasBot = Object.prototype.hasOwnProperty.call(body, "botId");
  const botId = hasBot ? String(body.botId || "").trim() : "";
  if (computerId && hasBot) return { computerId, botId };
  const raw = String(paramId || "").replace(/^cloud[:-]/, "");
  const m = raw.match(/^(cmp_[a-z0-9_]+)(?:-(.+))?$/i);
  // `m` is non-null here, and group 1 of a regex that matched always
  // participated — noUncheckedIndexedAccess cannot see either fact.
  const derivedComputer = m ? m[1]! : raw;
  const derivedBot = m?.[2] ? `cloud-${derivedComputer}-${m[2]}` : "";
  return {
    computerId: computerId || derivedComputer,
    botId: hasBot ? botId : derivedBot,
  };
}

export function mapLiveComputer(c: LiveComputer): CloudDesk {
  const sku = c?.sku || "vm.4g";
  return {
    id: c.id,
    name: `${sku.replace("vm.", "").toUpperCase()} desk · ${String(c.id || "").replace(/^cmp_/, "").slice(0, 6)}`,
    kind: "cloud",
    status: c.status,
    sku,
    ram: SKU_RAM[sku] || "4 GB",
    region: "nyc3",
    ipv4: c.ipv4 || "",
    streamUrl: withNovncAutoconnect(c.streamUrl) || streamForDisplay(c.ipv4),
    error: c.error || "",
    draft: false,
    attachedBotId: null,
    attachedBotName: null,
  };
}

export function withNovncAutoconnect(url: unknown): string {
  const s = String(url || "").trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  if (!/vnc\.html$/i.test(u.pathname) && u.pathname !== "/") return s;
  u.searchParams.set("autoconnect", "true");
  u.searchParams.set("reconnect", "true");
  u.searchParams.set("reconnect_delay", "1500");
  u.searchParams.set("resize", "scale");
  u.hash = "autoconnect=true&reconnect=true&resize=scale";
  return u.toString();
}

function displayNum(display: unknown = 1): number {
  const n = Number(String(display ?? "1").replace(/^:/, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function streamForDisplay(ipv4: string | undefined, display: unknown = 1): string {
  if (!ipv4) return "";
  const n = displayNum(display);
  const port = n <= 1 ? 3000 : 3000 + n;
  return withNovncAutoconnect(`http://${ipv4}:${port}/vnc.html`);
}

export function cloudStreamProbeUrl(desk: CloudDesk | null | undefined, display: unknown = 1): string {
  if (!desk?.ipv4) return "";
  const n = displayNum(display);
  const port = n <= 1 ? 3000 : 3000 + n;
  return `http://${desk.ipv4}:${port}/vnc.html`;
}

export async function probeCloudStream({ computerId, display = 1 }: ProbeStreamOptions = {}): Promise<StreamProbe> {
  let desk = lastLiveComputers.find((c) => c.id === computerId);
  if (!desk?.ipv4) {
    try {
      await liveSnapshot();
    } catch {
      /* keep empty */
    }
    desk = lastLiveComputers.find((c) => c.id === computerId);
  }
  if (!desk?.ipv4) return { ok: false, reason: "unknown" };
  const url = cloudStreamProbeUrl(desk, display);
  try {
    const r = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(3500) });
    return { ok: r.status >= 200 && r.status < 500, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function botFromComputer(c: LiveComputer): CloudBot {
  const desk = mapLiveComputer(c);
  const ready = desk.status === "assigned" || desk.status === "warm";
  return {
    id: cloudBotId(desk.id),
    name: desk.name || "Cloud",
    color: "#8f4fba",
    description: "Always-on Cloud desk",
    instructions: "",
    avatar: { expression: "think", animation: "look", body: "rounder", color: "#8f4fba" },
    harness: { provider: "grok-build", model: "grok-4.6" },
    // Unpinned: the chief of a desk with no team row follows the ACCOUNT
    // default (resolved when the draft is assembled). Seeding "cloud-grok"
    // here made that default unreachable — the row already had a value.
    identityId: "",
    messages: [],
    routines: [],
    computerId: desk.id,
    place: "cloud",
    draft: false,
    vm: {
      kind: "cloud",
      computerId: desk.id,
      status: ready ? "running" : "starting",
      hint: desk.status,
      streamUrl: streamForDisplay(desk.ipv4, 1) || withNovncAutoconnect(desk.streamUrl),
      display: ":1",
    },
    desk,
  };
}

function workerCloudIdentityId(identityId: string | undefined): string {
  const id = String(identityId || "").trim();
  if (!id) return "";
  if (id === "cloud-claude" || id.startsWith("cloud-claude")) return "cloud-claude";
  if (id === "cloud-key" || id.startsWith("cloud-api-")) return "cloud-key";
  if (id === "cloud-grok" || id.startsWith("cloud-grok")) return "cloud-grok";
  return id;
}

function defaultCloudIdentityId(brain: CloudBrain | null | undefined): string {
  // The account-wide default (Settings → Identities / POST /api/brain/identity)
  // wins. Deriving it from the brain row's provider pinned every cloud chief
  // to Grok — Dan's "hi" from the desktop went to a Grok with no credit while
  // the account said cloud-claude.
  const chosen = workerCloudIdentityId(String((brain as { identityId?: unknown } | null | undefined)?.identityId || ""));
  if (chosen) return chosen;
  const provider = String(brain?.provider || "");
  if (provider === "claude" || /^claude/i.test(provider)) return "cloud-claude";
  if (brain?.grokSignedIn || provider === "grok-oauth" || provider === "grok-build") return "cloud-grok";
  if (brain?.apiKeySet) return "cloud-key";
  return "cloud-grok";
}

function harnessForCloudIdentity(
  identityId: string | undefined,
  brain: CloudBrain | null | undefined,
): CloudBotHarness {
  const id = workerCloudIdentityId(identityId) || defaultCloudIdentityId(brain);
  if (id === "cloud-claude") {
    return {
      provider: "claude",
      // The login's chosen model (Settings → Harnesses → Cloud), not a constant.
      model: String(brain?.claudeModel || (/^claude/i.test(String(brain?.model || "")) ? brain?.model : "") || "claude-sonnet-5"),
      signedIn: Boolean(brain?.claudeCredentials),
      apiKeySet: Boolean(brain?.apiKeySet),
    };
  }
  if (id === "cloud-key") {
    const provider = String(brain?.provider || "spacexai");
    return {
      provider: provider === "grok-oauth" || provider === "claude" ? "spacexai" : provider,
      model: String(brain?.model || ""),
      signedIn: Boolean(brain?.grokSignedIn),
      apiKeySet: Boolean(brain?.apiKeySet),
    };
  }
  const grokModel = String(brain?.grokModel || brain?.model || "grok-4.6");
  return {
    provider: "grok-build",
    model: /^grok/i.test(grokModel) ? grokModel : "grok-4.6",
    signedIn: Boolean(brain?.grokSignedIn),
    apiKeySet: Boolean(brain?.apiKeySet),
  };
}

export function botFromCloudMember(c: LiveComputer, member: CloudTeamMember, brain: CloudBrain | null | undefined): CloudBot {
  const desk = mapLiveComputer(c);
  const ready = desk.status === "assigned" || desk.status === "warm";
  const display = Number(member?.display) || 1;
  const base = botFromComputer(c);
  const identityId = workerCloudIdentityId(member.identityId) || defaultCloudIdentityId(brain);
  return {
    ...base,
    id: member.id,
    name: member.name || base.name,
    color: member.color || base.color,
    description: member.job || base.description,
    instructions: member.job || "",
    teamId: `team-${desk.id}`,
    teamRole: member.role || "worker",
    avatar: { ...base.avatar, ...((member.avatar as object | undefined) || {}), color: member.color || base.color, ...(member.photo ? { photo: member.photo } : {}) },
    identityId,
    harness: harnessForCloudIdentity(identityId, brain),
    vm: {
      ...base.vm,
      display: `:${display}`,
      streamUrl: streamForDisplay(desk.ipv4, display) || desk.streamUrl,
      status: ready ? "running" : "starting",
    },
  };
}

export async function liveSnapshot(): Promise<LiveSnapshot> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) return { computers: [], bots: [], brain: { connected: false } };
  const token = row.session.token;
  const [data, brain]: [LiveComputersBody, CloudBrain] = await Promise.all([
    cloudLiveComputers({ token }),
    cloudLiveBrain({ token }).catch(() => ({ connected: false })),
  ]);
  const raw = data.computers || [];
  const computers = raw.map(mapLiveComputer);
  const live = raw.filter((c) => c.status !== "dead" && c.status !== "destroying");
  // Admins receive every desk (warm pool included); only the user's own desks become bots.
  // `row.session!`: sessionLive above proved it, but the narrowing does not
  // survive into a callback. Same at the three other closures in this file.
  const mine = live.filter((c) => c.userId === row.session!.userId);
  const bots: CloudBot[] = [];
  for (const c of mine) {
    let team: CloudTeamBody | null = null;
    try {
      team = await cloudLiveBrainTeam({ token, computerId: c.id });
    } catch {
      team = null;
    }
    const members = team?.members?.length ? team.members : null;
    const rows = members
      ? members.map((m) => botFromCloudMember(c, m, brain))
      : [botFromComputer(c)];
    const threaded = await Promise.all(
      rows.map(async (bot) => {
        bot.brain = brain;
        bot.identityId = workerCloudIdentityId(bot.identityId) || defaultCloudIdentityId(brain);
        bot.harness = harnessForCloudIdentity(bot.identityId, brain);
        try {
          const thread: CloudThreadBody = await cloudLiveBrainThread({ token, computerId: c.id, botId: bot.id });
          bot.messages = thread.messages || [];
        } catch {
          bot.messagesFailed = true;
          bot.messages = [];
        }
        return bot;
      }),
    );
    bots.push(...threaded);
  }
  lastSnapshotBots = bots.map((b) => ({ id: b.id, computerId: b.computerId || b.vm?.computerId || "" }));
  lastLiveComputers = computers;
  const teams: CloudTeam[] = [];
  const seen = new Set();
  for (const b of bots) {
    if (b.teamId && !seen.has(b.teamId)) {
      seen.add(b.teamId);
      const members = bots.filter((x) => x.teamId === b.teamId);
      teams.push({
        id: b.teamId,
        name: members.find((x) => x.teamRole === "chief")?.name || "Cloud team",
        chiefId: members.find((x) => x.teamRole === "chief")?.id || members[0]?.id,
        memberIds: members.map((x) => x.id),
        job: null,
      });
    }
  }
  for (const t of teams) {
    const cid = String(t.id || "").replace(/^team-/, "");
    try {
      const row: CloudTeamBody = await cloudLiveBrainTeam({ token, computerId: cid });
      if (row?.job) t.job = row.job;
      if (row?.name) t.name = row.name;
    } catch {
      /* keep */
    }
  }
  return { computers, bots, brain, teams };
}

let lastSnapshotBots: SnapshotBotRef[] = [];
let lastLiveComputers: CloudDesk[] = [];

/** Cheap steady-state poll: thread tails only for the bots the last snapshot knew, no computer refresh. */
export async function liveThreadTails(): Promise<ThreadTail[] | null> {
  const row = await loadAccount();
  if (!sessionLive(row.session) || !lastSnapshotBots.length) return null;
  const token = row.session.token;
  const out: ThreadTail[] = [];
  for (const b of lastSnapshotBots) {
    try {
      const thread: CloudThreadBody = await cloudLiveBrainThread({ token, computerId: b.computerId, botId: b.id });
      out.push({ botId: b.id, messages: thread.messages || [], messagesFailed: false });
    } catch {
      out.push({ botId: b.id, messages: null, messagesFailed: true });
    }
  }
  return out;
}

export async function liveBrain(): Promise<CloudBrain> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrain({ token: row.session.token });
}

/** Claude desk login — the desktop twin of the iOS flow. See cloud/index.mts. */
async function claudeAuthToken(): Promise<string> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return row.session!.token;
}

export async function liveBrainClaudeAuth(computerId: string): Promise<unknown> {
  return cloudLiveBrainClaudeAuth({ token: await claudeAuthToken(), computerId });
}

/** The synced envelope, as account.mts moves it (opaque here). */
export type CloudVaultEnvelopeLike = { header?: unknown; data: unknown; updatedAt?: number };
export async function vaultGateStatus(): Promise<{ exists: boolean; locked: boolean; remaining: number } | null> {
  return (await cloudGateStatus({ token: await claudeAuthToken() })) as { exists: boolean; locked: boolean; remaining: number } | null;
}
export async function vaultGateSetup(passcode: string, vaultKey: string): Promise<void> {
  await cloudGateSetup({ token: await claudeAuthToken(), passcode, vaultKey });
}
export async function vaultGateUnlock(passcode: string): Promise<{ ok: boolean; vaultKey?: string; locked?: boolean; remaining?: number; error?: string }> {
  return (await cloudGateUnlock({ token: await claudeAuthToken(), passcode })) as { ok: boolean; vaultKey?: string; locked?: boolean; remaining?: number; error?: string };
}
/** Pick the model one cloud identity runs (Settings → Harnesses → Cloud → Model). */
export async function setCloudModel(identityId: string, model: string): Promise<unknown> {
  const row = await requireLiveSession();
  return cloudLiveBrainSetModel({ token: row.session.token, identityId, model });
}

export async function vaultGateReset(): Promise<void> {
  await cloudGateReset({ token: await claudeAuthToken() });
}

/** Present-to-approve fills a cloud Bot is waiting on. */
export async function vaultFillPending(): Promise<{ requests: { id: string; botId: string; botName: string; computerId: string; accountId: string; label: string; site: string; username: string; ts: number }[] }> {
  const r = (await cloudVaultFillPending({ token: await claudeAuthToken() })) as { requests?: unknown[] } | null;
  return { requests: (Array.isArray(r?.requests) ? r!.requests : []) as { id: string; botId: string; botName: string; computerId: string; accountId: string; label: string; site: string; username: string; ts: number }[] };
}
export async function vaultFillApprove(id: string, secret: string): Promise<void> {
  await cloudVaultFillApprove({ token: await claudeAuthToken(), id, secret });
}
export async function vaultFillDeny(id: string): Promise<void> {
  await cloudVaultFillDeny({ token: await claudeAuthToken(), id });
}

export async function getCloudVault(): Promise<CloudVaultEnvelopeLike | null> {
  return (await cloudGetVault({ token: await claudeAuthToken() })) as CloudVaultEnvelopeLike | null;
}
export async function putCloudVault(envelope: unknown): Promise<void> {
  await cloudPutVault({ token: await claudeAuthToken(), envelope });
}
export async function deleteCloudVault(): Promise<void> {
  await cloudDeleteVault({ token: await claudeAuthToken() });
}
export async function getCloudEscrowKey(): Promise<string | null> {
  const r = (await cloudGetEscrowKey({ token: await claudeAuthToken() })) as { key?: string } | null;
  return r && typeof r.key === "string" && r.key ? r.key : null;
}
export async function putCloudEscrowKey(key: string): Promise<void> {
  await cloudPutEscrowKey({ token: await claudeAuthToken(), key });
}

export async function liveBrainPlugins(computerId: string, provider = "claude", refresh = false): Promise<unknown> {
  return cloudLiveBrainPlugins({ token: await claudeAuthToken(), computerId, provider, refresh });
}

export async function liveBrainClaudeAuthStart(computerId: string): Promise<unknown> {
  return cloudLiveBrainClaudeAuthStart({ token: await claudeAuthToken(), computerId });
}

export async function liveBrainClaudeAuthCode(computerId: string, code: string): Promise<unknown> {
  return cloudLiveBrainClaudeAuthCode({ token: await claudeAuthToken(), computerId, code });
}

export async function liveBrainClaudeForget(): Promise<unknown> {
  return cloudLiveBrainClaudeForget({ token: await claudeAuthToken() });
}

export async function liveBrainClaudeAuthLogout(computerId: string): Promise<unknown> {
  return cloudLiveBrainClaudeAuthLogout({ token: await claudeAuthToken(), computerId });
}

export async function liveBrainStartGrok(): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainStartGrok({ token: row.session.token });
}

export async function liveBrainWaitGrok(id: string | undefined): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainWaitGrok({ token: row.session.token, id });
}

export async function liveBrainKey(body?: BrainKeyBody): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainKey({ token: row.session.token, ...body });
}

// Four routine verbs share one guard, so read the live session token once here
// rather than repeating the sessionLive dance in each of them.
async function cloudSessionToken(): Promise<string> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return row.session.token;
}

export async function liveBrainRoutines({ computerId }: DeskOptions = {}): Promise<unknown> {
  return cloudLiveBrainRoutines({ token: await cloudSessionToken(), computerId });
}

export async function liveBrainRoutineCreate({ computerId, name, instruction, intervalMinutes, botId }: RoutineOptions = {}): Promise<unknown> {
  return cloudLiveBrainRoutineCreate({
    token: await cloudSessionToken(),
    computerId,
    name,
    instruction,
    intervalMinutes,
    botId,
  });
}

export async function liveBrainRoutinePatch({ computerId, id, name, instruction, intervalMinutes, enabled, botId }: RoutineOptions = {}): Promise<unknown> {
  return cloudLiveBrainRoutinePatch({
    token: await cloudSessionToken(),
    computerId,
    id,
    name,
    instruction,
    intervalMinutes,
    enabled,
    botId,
  });
}

export async function liveBrainRoutineDelete({ computerId, id }: RoutineOptions = {}): Promise<unknown> {
  return cloudLiveBrainRoutineDelete({ token: await cloudSessionToken(), computerId, id });
}

export async function liveCreateMate({ computerId, name, job }: MateOptions = {}) {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  const token = row.session.token;
  let id = liveDeskId(computerId);
  if (!id) {
    const data: LiveComputersBody = await cloudLiveComputers({ token });
    const mine = (data.computers || []).find((c) => c.userId === row.session!.userId && c.status === "assigned");
    id = mine?.id || "";
  }
  if (!id) {
    const err = new Error("Create a Cloud desk first.") as CloudError;
    err.status = 409;
    err.code = "NEED_DESK";
    throw err;
  }
  const out: CreateMateBody = await cloudLiveCreateMate({ token, computerId: id, name, job });
  const snap = await liveSnapshot();
  const bot = (snap.bots || []).find((b) => b.id === out.bot?.id) || null;
  return { bot, created: out.created, ...snap };
}

async function requireLiveSession(): Promise<LiveAccountRow> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  // sessionLive returned true, so row.session is set. The assertion emits
  // nothing; it only lets the two callers below read row.session.token.
  return row as LiveAccountRow;
}

export async function liveDeskAction({
  computerId,
  action,
}: {
  computerId?: string | undefined;
  action?: Record<string, unknown> | undefined;
} = {}): Promise<unknown> {
  const row = await requireLiveSession();
  const id = liveDeskId(computerId, "");
  if (!id) {
    const err = new Error("Desk not ready.") as CloudError;
    err.code = "NEED_DESK";
    throw err;
  }
  return cloudLiveDeskAction({ token: row.session.token, computerId: id, action });
}

export async function liveSaveThread({
  computerId,
  botId,
  messages,
}: {
  computerId?: string | undefined;
  botId?: string | undefined;
  messages?: unknown[] | undefined;
} = {}): Promise<unknown> {
  const row = await requireLiveSession();
  const id = liveDeskId(computerId, botId);
  if (!id) {
    const err = new Error("Desk not ready.") as CloudError;
    err.code = "NEED_DESK";
    throw err;
  }
  return cloudSaveThread({
    token: row.session.token,
    computerId: id,
    botId,
    messages: chatMessages(messages as Parameters<typeof chatMessages>[0]),
  });
}

export async function livePatchMate({ computerId, botId, name, job, identityId, photo, avatar }: MateOptions = {}) {
  const row = await requireLiveSession();
  const id = liveDeskId(computerId, botId);
  if (!id || !botId) {
    const err = new Error("Teammate not found.") as CloudError;
    err.status = 404;
    throw err;
  }
  await cloudLivePatchMate({ token: row.session.token, computerId: id, botId, name, job, identityId, photo, avatar });
  const snap = await liveSnapshot();
  const bot = (snap.bots || []).find((b) => b.id === botId) || null;
  return { bot, ...snap };
}

export async function liveDeleteMate({ computerId, botId }: MateOptions = {}): Promise<LiveSnapshot> {
  const row = await requireLiveSession();
  const id = liveDeskId(computerId, botId);
  if (!id || !botId) {
    const err = new Error("Teammate not found.") as CloudError;
    err.status = 404;
    throw err;
  }
  await cloudLiveDeleteMate({ token: row.session.token, computerId: id, botId });
  return liveSnapshot();
}

export async function liveBrainChat({ computerId, content, botId, display, persistUser, identityId }: ChatOptions = {}): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainChat({ token: row.session.token, computerId, content, botId, display, persistUser, identityId });
}

export async function liveBrainTurn({ computerId, id }: TurnOptions = {}): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainTurn({ token: row.session.token, computerId, id });
}

export async function liveBrainAbort({ computerId, turnId, all }: AbortOptions = {}): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainAbort({ token: row.session.token, computerId, turnId, all });
}

export async function liveBillingSummary(): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBillingSummary({ token: row.session.token });
}

export async function liveBillingPortal(): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBillingPortal({ token: row.session.token });
}

export async function liveBillingCheckout(items: unknown): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBillingCheckout({ token: row.session.token, items });
}

/** Same runTurn as Local. Desk-agent is only the remote docker-exec pipe. */
export async function liveCloudTurn({ computerId, content, signal, persistUser = true, botId, display }: CloudTurnOptions = {}) {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudRunTurn({ token: row.session.token, computerId, content, signal, persistUser, botId, display });
}

export async function liveCloudAppend({ computerId, content, botId }: CloudAppendOptions = {}) {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudAppendUser({ token: row.session.token, computerId, content, botId });
}

export async function liveBrainControl({ computerId, on }: BrainControlOptions): Promise<unknown> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return cloudLiveBrainControl({ token: row.session.token, computerId, on });
}

/** Prefer the Worker create payload over computers[0], which may be an older desk. */
export function createdDeskFromLive(created: CreatedComputer | null | undefined, snap: LiveSnapshot | null | undefined): CloudDesk | null {
  const raw = created?.computer || (created?.id ? created : null);
  if (!raw?.id) return null;
  return (snap?.computers || []).find((c) => c.id === raw.id) || mapLiveComputer(raw);
}

export async function liveCreateDesk(sku: string | undefined) {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  const created: CreatedComputer = await cloudLiveCreate({ token: row.session.token, sku: sku || "vm.4g" });
  const snap = await liveSnapshot();
  return { computer: createdDeskFromLive(created, snap), ...snap };
}

export async function liveDestroyDesk(id: string | undefined): Promise<LiveSnapshot> {
  const row = await loadAccount();
  if (!sessionLive(row.session)) {
    const err = new Error("Sign in to use Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  await cloudLiveDestroy({ token: row.session.token, id });
  return liveSnapshot();
}

export function sessionLive(session: AccountSession | null | undefined, now = Date.now()): session is AccountSession {
  if (!session?.token && !session?.email && !session?.handle) return false;
  if (session.expiresAt && Number(session.expiresAt) <= now) return false;
  return true;
}

export function decideGate(row: AccountRow | null | undefined, { requireAccount: must, hasLocalBots }: GateOptions = {}): AccountGate {
  const force = must === true;
  const signedIn = sessionLive(row?.session);
  let place = row?.place || null;
  let inferred = Boolean(row?.inferred);
  if (!place && hasLocalBots) {
    place = "local";
    inferred = true;
  }
  const needsChoice = !place || (place === "cloud" && !signedIn);
  const hideLocal = force && !place && !hasLocalBots;
  const ready = place === "local" || (place === "cloud" && signedIn);
  const view = signedIn && row?.view === "cloud" ? "cloud" : "local";
  const needsCloudPrompt =
    ready && place === "local" && !signedIn && !row?.cloudPromptDismissed && !needsChoice;
  return {
    ready,
    needsChoice,
    needsCloudPrompt,
    requireAccount: force,
    hideLocal,
    place,
    view,
    signedIn,
    inferred,
    cloudEnabled: signedIn,
    cloudPromptDismissed: Boolean(row?.cloudPromptDismissed),
    // `row.session!`: signedIn is sessionLive(row?.session), which is true only
    // for a session that is there. TS carries that as far as `row` and stops.
    email: signedIn ? row.session!.email : null,
    handle: signedIn ? row.session!.handle || null : null,
    userId: signedIn ? row.session!.userId || null : null,
    photoUrl: signedIn ? row.session!.photo || null : null,
  };
}

export function disabledAccount(): PublicAccount {
  return {
    enabled: false,
    ready: true,
    needsChoice: false,
    needsCloudPrompt: false,
    requireAccount: false,
    hideLocal: false,
    place: "local",
    view: "local",
    signedIn: false,
    inferred: false,
    cloudEnabled: false,
    cloudPromptDismissed: true,
    email: null,
    handle: null,
    userId: null,
    photoUrl: null,
    mockAuth: false,
    cloudConfigured: false,
    comingSoon: false,
    cloudProduct: false,
    xLogin: false,
    cloudAccess: false,
  };
}

export function publicAccount(row: AccountRow | null | undefined, opts: GateOptions = {}): PublicAccount {
  if (!cloudFeaturesEnabled()) return disabledAccount();
  const gate = decideGate(row, opts);
  const invited = Boolean(row?.session?.cloudAccess || row?.session?.admin);
  const product = cloudProductEnabled() || invited;
  const comingSoon = !product;
  if (comingSoon) {
    gate.needsChoice = false;
    gate.needsCloudPrompt = false;
    gate.ready = true;
    gate.hideLocal = false;
    gate.view = "local";
  }
  return {
    ...gate,
    enabled: true,
    comingSoon,
    cloudProduct: product,
    cloudAccess: invited,
    handle: gate.signedIn ? row?.session?.handle || null : null,
    mockAuth: useMockAuth(),
    cloudConfigured: Boolean(cloudBaseUrl()) && cloudBaseUrl() !== "mock",
    xLogin: !useMockAuth(),
  };
}

export async function loadAccount({ hasLocalBots = false }: LoadAccountOptions = {}): Promise<AccountRow> {
  let row = blank();
  try {
    row = normalize(JSON.parse(await fs.readFile(accountPath(), "utf8")));
  } catch {
    row = blank();
  }
  if (!row.place && hasLocalBots) {
    row = { ...blank(), place: "local", view: "local", inferred: true, cloudPromptDismissed: false, updatedAt: Date.now() };
    await saveAccount(row);
  }
  return row;
}

export async function saveAccount(row: AccountRowInput): Promise<AccountRow> {
  const next = normalize({ ...row, updatedAt: Date.now() });
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonAtomic(accountPath(), next);
  return next;
}

export async function chooseLocal(): Promise<AccountRow> {
  if (requireAccount()) {
    const err = new Error("This build requires a Sub8 account.") as CloudError;
    err.code = "ACCOUNT_REQUIRED";
    throw err;
  }
  const prev = await loadAccount();
  return saveAccount({
    ...prev,
    place: "local",
    view: "local",
    inferred: false,
    cloudPromptDismissed: true,
    session: prev.session,
  });
}

export async function dismissCloudPrompt(): Promise<AccountRow> {
  const prev = await loadAccount();
  return saveAccount({ ...prev, cloudPromptDismissed: true });
}

export async function setView(view: unknown): Promise<AccountRow> {
  const next = view === "cloud" ? "cloud" : "local";
  const prev = await loadAccount();
  if (next === "cloud" && !cloudProductEnabled() && !prev.session?.cloudAccess && !prev.session?.admin) {
    const err = new Error("Cloud desks are coming soon.") as CloudError;
    err.code = "CLOUD_SOON";
    throw err;
  }
  if (next === "cloud" && !sessionLive(prev.session)) {
    const err = new Error("Sign in to open Cloud.") as CloudError;
    err.code = "SIGN_IN";
    throw err;
  }
  return saveAccount({ ...prev, view: next, place: next === "cloud" ? "cloud" : prev.place || "local" });
}

export async function signInMock(emailRaw: unknown): Promise<AccountRow> {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    const err = new Error("Enter a valid email.") as CloudError;
    err.code = "BAD_EMAIL";
    throw err;
  }
  if (!useMockAuth()) {
    const err = new Error("Cloud sign-in is not configured.") as CloudError;
    err.code = "NO_CLOUD";
    throw err;
  }
  const started = await cloudStartMagic(email);
  if (!started.session) {
    const err = new Error("Cloud sign-in is not configured.") as CloudError;
    err.code = "NO_CLOUD";
    throw err;
  }
  return saveAccount({
    place: "cloud",
    view: "cloud",
    inferred: false,
    cloudPromptDismissed: true,
    session: started.session,
  });
}

export async function startMagic(emailRaw: unknown) {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    const err = new Error("Enter a valid email.") as CloudError;
    err.code = "BAD_EMAIL";
    throw err;
  }
  const started = await cloudStartMagic(email);
  if (started.session) {
    const row = await saveAccount({
      place: "cloud",
      view: "cloud",
      inferred: false,
      cloudPromptDismissed: true,
      session: started.session,
    });
    // `row.session!`: started.session carried a token, so normalize kept it.
    return { ok: true, mock: Boolean(started.mock), signedIn: true, email: row.session!.email };
  }
  return { ok: true, mock: Boolean(started.mock), signedIn: false, email };
}

export async function refreshSessionAccess(row?: AccountRow | null): Promise<AccountRow> {
  const prev = row || (await loadAccount());
  if (!sessionLive(prev.session) || useMockAuth()) return prev;
  try {
    const me = await cloudLiveMe({ token: prev.session.token });
    if (!me) return prev;
    return saveAccount({
      ...prev,
      session: {
        ...prev.session,
        cloudAccess: Boolean(me.cloudAccess || me.admin),
        admin: Boolean(me.admin),
      },
    });
  } catch {
    return prev;
  }
}

export async function requestCloudAccess(emailRaw?: unknown): Promise<AccountRow> {
  const prev = await loadAccount();
  const email = normalizeEmail(emailRaw) || prev.session?.email || "";
  if (useMockAuth()) {
    if (!sessionLive(prev.session)) {
      const err = new Error("Sign in first, or enter an email.") as CloudError;
      err.code = "SIGN_IN";
      throw err;
    }
    return saveAccount({ ...prev, session: { ...prev.session, cloudAccess: true } });
  }
  await cloudRequestAccess({ email, token: prev.session?.token });
  return refreshSessionAccess(await loadAccount());
}

export async function completeSession(payload: SessionPayload | null | undefined): Promise<AccountRow> {
  const handle = String(payload?.handle || "").trim();
  const email = normalizeEmail(payload?.email) || (handle ? `${handle.toLowerCase()}@x.local` : "");
  const token = String(payload?.token || "").trim();
  const userId = String(payload?.userId || "").trim() || randomUUID();
  if ((!email && !handle) || !token) {
    const err = new Error("Sign-in did not finish.") as CloudError;
    err.code = "BAD_SESSION";
    throw err;
  }
  const saved = await saveAccount({
    place: cloudProductEnabled() ? "cloud" : "local",
    view: cloudProductEnabled() ? "cloud" : "local",
    inferred: false,
    cloudPromptDismissed: true,
    session: {
      email,
      handle,
      userId,
      token,
      expiresAt: payload?.expiresAt || null,
      photo: String(payload?.photo || "").trim(),
      cloudAccess: Boolean(payload?.cloudAccess || payload?.admin),
      admin: Boolean(payload?.admin),
    },
  });
  return refreshSessionAccess(saved);
}

const xPumps = new Map<string, Promise<void>>();

function pumpXWait(state: unknown): void {
  const raw = String(state || "").trim();
  if (!raw || xPumps.has(raw)) return;
  const run = (async () => {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const local = await loadAccount();
        if (sessionLive(local.session)) return;
        const row = await cloudWaitX(raw);
        if (row?.signedIn && row.token) {
          await completeSession(row);
          return;
        }
        if (row?.error && row.error !== "unknown state" && !row.signedIn) return;
      } catch {
        /* Browser is often focused on x.com; keep polling from Node. */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  })();
  xPumps.set(raw, run);
  run.finally(() => xPumps.delete(raw));
}

export async function startX() {
  const started: CloudStartX = await cloudStartX();
  if (started.session) {
    const row = await saveAccount({
      place: cloudProductEnabled() ? "cloud" : "local",
      view: cloudProductEnabled() ? "cloud" : "local",
      inferred: false,
      cloudPromptDismissed: true,
      session: started.session,
    });
    return {
      ok: true,
      mock: true,
      signedIn: true,
      // `row.session!`: same as startMagic — the saved session had a token.
      email: row.session!.email,
      handle: row.session!.handle || "",
    };
  }
  if (started.state) pumpXWait(started.state);
  return {
    ok: true,
    mock: false,
    signedIn: false,
    authorizeUrl: started.authorizeUrl,
    state: started.state,
    code: started.code || "",
  };
}

export async function waitX(state: unknown) {
  const raw = String(state || "").trim();
  if (!raw) {
    const err = new Error("Missing sign-in state.") as CloudError;
    err.code = "BAD_SESSION";
    throw err;
  }
  const local = await loadAccount();
  if (sessionLive(local.session)) return { signedIn: true };
  const row = await cloudWaitX(raw);
  if (row?.error && row.error !== "unknown state" && !row.signedIn) {
    const err = new Error(row.error) as CloudError;
    err.code = "CLOUD";
    throw err;
  }
  if (!row.signedIn || !row.token) return { signedIn: false };
  await completeSession(row);
  return { signedIn: true };
}

export async function logout(): Promise<AccountRow> {
  const must = requireAccount();
  const prev = await loadAccount();
  // Tell the Worker to drop the session before we forget it locally. Without
  // this the token stayed valid for the full 30-day TTL, so a copy taken off
  // disk kept working long after the user signed out. Best-effort: an
  // unreachable Worker must not leave them stuck signed in.
  try {
    if (prev.session?.token) await cloudRevokeSession(prev.session.token);
  } catch {
    /* offline, or a Worker predating /auth/logout */
  }
  return saveAccount({
    ...prev,
    place: must ? null : "local",
    view: "local",
    inferred: false,
    session: null,
  });
}
