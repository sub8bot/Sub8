import { animList, bodyList, defaultAvatar, faceList, inferMood, isSleepingMood, randomCreateFace, randomWakeMood, syncAvatars } from "./avatar.js";
import { AVATAR_COLORS } from "./palette.js";
import { applyHealthPort, CONNECTING_AFTER_MS, cloudFrameKey, frameKey, healthIframeIsCurrent, novncAutoconnectUrl, shouldKickCloudFrame, shouldMountCloudFrame, shouldShowConnecting } from "./stream-bind.mjs";
import { listModelsForProvider, modelFieldKind, pickListedModel } from "./harness-models.mjs";
import { formatChatText } from "./markdown.js";
import { HARNESS_INSTALL, apiPreset, brainSetupHtml, harnessSetupBannerHtml, needsBrainSetup } from "./brain-setup.mjs";
import { mergeCloudMessages, mergeCloudDraft, isTransientChatStatus } from "./chat-merge.mjs";
import { api } from "./api-client.mjs";
import { iconAbout, iconBack, iconChevrons, iconClip, iconClock, iconClose, iconCompact, iconComputer, iconExpand, iconGear, iconGitHub, iconGlobe, iconHarness, iconLicense, iconLock, iconMic, iconMonitor, iconPerson, iconPlus, iconRecord, iconSend, iconStop } from "./icons.mjs";
import * as cloudPlace from "./cloud-place.mjs";
import type { Avatar } from "./avatar.js";
import type { BrainApiDraft } from "./brain-setup.mjs";
import type { CloudRoutine } from "./cloud-place.mjs";
import type { ModelCatalogs } from "./harness-models.mjs";

// The shapes this shell works in.
//
// None of them validates anything: api() answers `unknown`, so every read of a
// server response is an assertion to one of these. What they buy is that the
// ~370 painters and handlers below all agree on what a bot, a message, a
// routine and a desk look like, so a renamed field stops being a silent no-op.
//
// Optional fields spell out `| undefined` wherever a possibly-undefined value
// is written into them — exactOptionalPropertyTypes treats `?:` as "may be
// absent", not "may be undefined", and the difference is load-bearing here.

/** The setup progress a starting desk reports, step N of total. */
interface VmSetup {
  step?: number;
  total?: number;
  label?: string;
  ready?: boolean;
}

/** The Linux desk attached to a bot: local Docker container, or a Cloud display. */
interface BotVm {
  status?: string;
  error?: string | null | undefined;
  hint?: string;
  container?: string;
  novncPort?: number;
  computerId?: string;
  detached?: boolean;
  streamUrl?: string;
  display?: string;
  kind?: string;
  setup?: VmSetup;
}

/** A brain, wherever it is attached: on the bot, or shared on the cloud draft. */
interface BotBrain {
  connected?: boolean;
  grokSignedIn?: boolean;
  grokName?: string;
  apiKeySet?: boolean;
  provider?: string;
  model?: string;
}

interface BotHarness {
  provider?: string;
  model?: string;
  label?: string;
  signedIn?: boolean;
  apiKeySet?: boolean;
  apiKey?: string;
  apiKeyHint?: string;
}

/** Where this conversation's files live on disk, for the Advanced sheet. */
interface BotStorage {
  sessionId?: string;
  harnessSessionId?: string;
  conversationFile?: string;
  botsFile?: string;
  screensFile?: string;
  dataDir?: string;
}

interface Choice {
  id?: string | undefined;
  label?: string | undefined;
}

/**
 * A code-agent run as it rides along on a message: on `codeAgent`, on
 * `session`, on an attachment, or — when the message itself is the run — as the
 * message. `content` is here so a Message satisfies this shape structurally,
 * which is the case codeAgentFromMsg's `return m` produces.
 */
interface CodeAgentSession {
  status?: string;
  cwd?: string;
  prUrl?: string;
  prompt?: string;
  content?: string;
}

interface MessageAttachment extends CodeAgentSession {
  kind?: string;
  type?: string;
  name?: string;
  codeAgent?: CodeAgentSession;
}

/** One line in a thread: chat, a thought, a tool tick, or a question card. */
interface Message extends CodeAgentSession {
  id?: string;
  role?: string;
  kind?: string;
  type?: string;
  content?: string;
  ts?: number;
  hidden?: boolean;
  pending?: boolean;
  choices?: Choice[];
  selected?: Choice | null;
  allowCustom?: boolean;
  hint?: string;
  speakerId?: string;
  speakerName?: string;
  speakerRole?: string;
  toId?: string;
  action?: string;
  name?: string;
  summary?: string;
  codeAgent?: CodeAgentSession;
  session?: CodeAgentSession;
  attachments?: MessageAttachment[];
  widgets?: MessageAttachment[];
}

interface RoutineRun {
  ts?: number;
}

interface RoutineSchedule {
  type?: string;
  hour?: number;
  minute?: number;
}

/** A standing job. Cloud rows arrive reshaped into this by normalizeCloudRoutine. */
interface Routine {
  id?: string;
  name?: string;
  instruction?: string;
  enabled?: boolean;
  botId?: string;
  intervalMs?: number;
  schedule?: RoutineSchedule;
  triggers?: Trigger[];
  runs?: RoutineRun[];
  lastRunAt?: number;
  cloud?: boolean;
}

/** A wall-clock slot on a trigger. Hour/minute are optional because a legacy
 *  `schedule` row can be missing either, and routineClock() answers "" for that. */
interface TriggerTime {
  hour?: number | undefined;
  minute?: number | undefined;
}

/** Every key a trigger can carry, all optional so a read before the `kind`
 *  check — clientTriggerLabel does exactly that — is still in bounds. */
interface TriggerFields {
  id: string;
  intervalMs?: number;
  times?: TriggerTime[];
  weekday?: number;
  monthDay?: number;
  months?: number[];
  days?: string;
  cron?: string;
}

/**
 * A schedule trigger, discriminated by `kind`. The union is what makes
 * `row.intervalMs` a number inside the "interval" branch and `row.cron` a
 * string inside the "cron" branch, without an assertion at either site.
 */
type Trigger =
  | (TriggerFields & { kind: "hourly"; intervalMs: number })
  | (TriggerFields & { kind: "interval"; intervalMs: number })
  | (TriggerFields & { kind: "daily"; times: TriggerTime[] })
  | (TriggerFields & { kind: "weekdays"; times: TriggerTime[] })
  | (TriggerFields & { kind: "weekly"; weekday: number; times: TriggerTime[] })
  | (TriggerFields & { kind: "monthly"; monthDay: number; times: TriggerTime[] })
  | (TriggerFields & { kind: "advanced"; months: number[]; days: string; times: TriggerTime[] })
  | (TriggerFields & { kind: "cron"; cron: string });

/** A trigger before normalizeClientTrigger has vouched for it. */
interface RawTrigger {
  id?: string;
  kind?: string;
  intervalMs?: number;
  times?: TriggerTime[];
  weekday?: number;
  monthDay?: number;
  months?: number[];
  days?: string;
  cron?: string;
}

/** One bot, local or Cloud. The rail, the chat and the editor all read this. */
interface Bot {
  id: string;
  name: string;
  /** Take control, persisted host-side so it survives a restart. */
  humanControl?: boolean;
  color?: string;
  title?: string;
  description?: string;
  instructions?: string;
  avatar?: Partial<Avatar>;
  harness?: BotHarness;
  identityId?: string;
  brain?: BotBrain;
  messages?: Message[];
  messagesTruncated?: boolean;
  routines?: Routine[];
  busy?: boolean;
  unread?: boolean;
  hidden?: boolean;
  pinned?: boolean;
  section?: string;
  teamId?: string;
  teamRole?: string;
  role?: string;
  vm?: BotVm | null;
  desk?: Computer;
  computerId?: string;
  place?: string;
  notificationsEnabled?: boolean;
  storage?: BotStorage;
  createdAt?: number;
  updatedAt?: number;
  grokSessionId?: string;
  harnessSessionId?: string;
  _loadingOlder?: boolean;
}

/** A Linux desk in the Computers sheet: a local container or a Cloud droplet. */
interface Computer {
  id: string;
  name: string;
  container?: string;
  status?: string;
  attachedBotId?: string;
  attachedBotName?: string;
  lastBotId?: string;
  previewBotId?: string;
  previewUrl?: string;
  harness?: BotHarness;
  stuck?: boolean;
  stale?: boolean;
  kind?: string;
  draft?: boolean;
  ipv4?: string;
  ram?: string;
  sku?: string;
  streamUrl?: string;
  error?: string;
}

interface ComputerStat {
  mem?: string;
  memPct?: number;
  memBytes?: number;
}

/** A local desk volume snapshot listed under Computers → Snapshot disk. */
interface DeskImage {
  id: string;
  computerId: string;
  volume?: string;
  fileName?: string;
  bytes?: number;
  createdAt?: number;
  note?: string;
}

interface JobStep {
  botId?: string;
  label?: string;
  status?: string;
  detail?: string;
  loopCount?: number;
}

interface TeamJob {
  title?: string;
  steps?: JobStep[];
}

interface Team {
  id: string;
  name?: string;
  chiefId?: string | null;
  memberIds?: string[];
  section?: string;
  pinned?: boolean;
  job?: TeamJob | undefined;
  messages?: Message[];
  members?: { id: string; role?: string }[];
}

interface Channel {
  id: string;
  name?: string;
  description?: string;
  memberIds?: string[];
}

/** One rail cluster: a team and the bots currently showing inside it. */
interface RailTeam {
  id: string;
  name?: string | undefined;
  bots: Bot[];
  section?: string;
  pinned?: boolean;
}

/** One rail band: a named sidebar section with its loose bots and its clusters. */
interface RailGroup {
  id: string;
  name?: string | undefined;
  bots: Bot[];
  teams: RailTeam[];
}

interface SidebarSection {
  id: string;
  name: string;
}

interface HarnessSettingsState {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  setupComplete?: boolean;
  setupSkipped?: boolean;
}

/** /api/settings. The index signature is the set-pref handler, which writes
 *  whatever key the clicked control names. */
interface Settings {
  harness?: HarnessSettingsState;
  sidebarSections?: SidebarSection[];
  themePreference?: string;
  [key: string]: unknown;
}

interface IdentityRow {
  id: string;
  label: string;
  place: "local" | "cloud";
  provider: string;
  kind?: string;
  subject?: string;
  runtimeRef?: string;
  model?: string;
  status?: string;
}

/** One harness as /api/harness/status reports it, plus the extras this file reads. */
interface HarnessRow {
  id: string;
  label: string;
  installed?: boolean;
  ready?: boolean;
  signedIn?: boolean;
  expired?: boolean;
  detail?: string;
  hint?: string;
  binary?: string;
  version?: string;
  model?: string;
  extra?: {
    email?: string;
    models?: string[];
    hermesProvider?: string;
    hermesBaseUrl?: string;
  };
}

interface HarnessStatusFull {
  harnesses?: Record<string, HarnessRow>;
  catalog?: { id: string; label: string }[];
  local?: LocalHarness;
}

/** What the server found running on this Mac, per provider. */
interface LocalHarnessEntry {
  ok?: boolean;
  models?: string[];
}

interface LocalHarness {
  ollama?: LocalHarnessEntry;
  lmstudio?: LocalHarnessEntry;
  grok?: LocalHarnessEntry;
  [provider: string]: LocalHarnessEntry | undefined;
}

interface HarnessTest {
  busy?: boolean;
  note?: string;
  log?: string;
  ok?: boolean;
  at?: number;
}

interface DockerState {
  ok?: boolean;
  cli?: boolean;
  stuck?: boolean;
  platform?: string;
  installing?: boolean;
  installLog?: string;
  hint?: string;
  engine?: string;
}

interface UpdateInfo {
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  downloadUrl?: string;
  downloadName?: string;
  releaseUrl?: string;
  siteUrl?: string;
  error?: string | null | undefined;
  justChecked?: boolean;
}

interface AccountState {
  enabled?: boolean;
  cloudProduct?: boolean;
  comingSoon?: boolean;
  view?: string;
  signedIn?: boolean;
  mockAuth?: boolean;
  email?: string;
  handle?: string;
  ready?: boolean;
  needsChoice?: boolean;
  needsCloudPrompt?: boolean;
  hideLocal?: boolean;
  xLogin?: boolean;
  cloudConfigured?: boolean;
  sent?: boolean;
  authorizeUrl?: string;
  state?: string;
}

/** The Cloud snapshot: draft desks, their bots, and the brain they share. */
interface CloudDraftState {
  computers?: Computer[];
  bots?: Bot[];
  teams?: Team[];
  brain?: BotBrain;
  bot?: Bot;
  computer?: Computer;
  userMessage?: Message;
  turnId?: string;
  reply?: { userMessage?: Message; turnId?: string };
}

interface CloudSku {
  id: string;
  name?: string;
  unitAmountCents?: number;
  maxBots?: number;
  blurb?: string;
  highlight?: boolean;
  used?: number;
  entitled?: number;
  quantity?: number;
  spare?: number;
  paidQuantity?: number;
}

/** A SKU row with the three counts cloudSkuUsage always fills in. */
interface CloudSkuUsage extends CloudSku {
  id: string;
  used: number;
  entitled: number;
  spare: number;
}

interface CloudBilling {
  skus?: CloudSku[];
  subscription?: unknown;
}

interface VaultGroup {
  id: string;
  name: string;
}

interface VaultAccount {
  id: string;
  label?: string;
  site?: string;
  username?: string;
  notes?: string;
  groupId?: string | undefined;
  password?: string;
  updatedAt?: number;
}

interface VaultSnapshot {
  groups?: VaultGroup[];
  accounts?: VaultAccount[];
  grants?: Record<string, string[] | undefined>;
}

/** One file staged in the composer. */
interface AttachedFile {
  name: string;
  type: string;
  dataUrl: string;
  text: string;
}

/** The rail's "poke a sleeping bot awake" state, valid until `until`. */
interface RailWake {
  id: string;
  mood: Avatar;
  until: number;
}

/** The open right-click menu. `type` picks which of the five it is. */
interface CtxMenu {
  type: string;
  x: number;
  y: number;
  botId?: string | undefined;
  teamId?: string | undefined;
  secId?: string | undefined;
  mid?: string;
  mids?: string;
  sub?: string | null;
  naming?: boolean;
}

/** The Advanced/Custom panel of the schedule popover, mid-edit. */
interface SchedAdvanced {
  months?: number[];
  days?: string;
  times?: TriggerTime[];
  cron?: string;
}

/** The schedule popover: which panel is open and what it has collected. */
interface SchedPop {
  panel: string;
  x: number;
  y: number;
  timeKind?: string | undefined;
  intervalN?: number;
  intervalUnit?: string;
  advanced?: SchedAdvanced;
  editId?: string | null;
}

interface BrainSetupState {
  tab?: string;
  api?: BrainApiDraft;
  busy?: boolean;
  error?: string;
}

/** /api/settings. */
interface SettingsPayload {
  settings: Settings;
  timezone: string;
  hasGrokAuth?: boolean;
  account?: AccountState;
  docker?: DockerState;
  appVersion?: string;
}

/** /api/cloud/brain/grok/start. */
interface CloudGrokStart {
  id?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
}

/** /api/docker/recover and /api/docker/install. */
interface DockerActionResult {
  ok?: boolean;
  docker?: DockerState;
  log?: string;
  hint?: string;
  computers?: Computer[];
}

/** /api/harness/grok-login. */
interface GrokLogin {
  message?: string;
  reused?: boolean;
  needHostLogin?: boolean;
}

/** /api/harness/test. */
interface HarnessTestResult {
  ok?: boolean;
  provider?: string;
  model?: string;
  error?: string;
  log?: string;
  sample?: string;
  at?: number;
}

/** /api/bots/:id/stream-health and its Cloud twin. */
interface StreamHealth {
  ok?: boolean;
  reason?: string;
  running?: boolean;
  novncPort?: number;
  docker?: DockerState;
}

/** What a catch block assumes it caught: api() throws ApiError, which carries a
 *  machine-readable `code` alongside Error's message. */
type CaughtError = Error & { code?: string };

/** A form control read for its `.value`. The same id is an <input>, a <select>
 *  or a <textarea> depending on which branch of the painter rendered it. */
type ValueEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** #send is a <form>; its textarea is named q, so form.q is that textarea. */
interface SendForm extends HTMLFormElement {
  q: HTMLTextAreaElement;
}

/**
 * What onSend reads off a submit. The bound listener hands it a SubmitEvent
 * whose target is #send; submitChoice's Cloud branch calls onSend with a bare
 * stand-in that has only preventDefault — see the note at that call.
 */
interface ComposerSubmit {
  preventDefault(): void;
  target?: EventTarget | null;
}

/** Everything the shell renders from. One object, mutated in place, read by every painter. */
interface AppState {
  bots: Bot[];
  selected: string | null;
  settings: Settings | null;
  timezone: string;
  modal: string | null;
  section: string | undefined;
  showComputer: boolean;
  botEdit: boolean;
  editingRoutineId: string | null | undefined;
  routineTriggers: Trigger[];
  cloudRoutines: { computerId: string; rows: Routine[] };
  schedPop: SchedPop | null;
  confirmDeleteId: string | null;
  deskSize: string;
  createFace: string;
  createHarness: string;
  createModel: string;
  createName: string;
  createDesc: string;
  createSku: string;
  createCloudKind: string;
  createCloudPay: boolean;
  cloudBilling: CloudBilling | null;
  cloudBillingError: string;
  paneWidth: number;
  railWidth: number;
  plusMenu: boolean;
  humanControl: boolean;
  railWake: RailWake | null;
  ctx: CtxMenu | null;
  hasGrokAuth: boolean | null;
  grokAuthAsk: false | "later" | "pending";
  brainSetup: BrainSetupState | null;
  docker: DockerState | null;
  dockerBusy: false | "install" | "recover";
  dockerLog: string;
  dockerInstallFailed: boolean;
  update: UpdateInfo | null;
  updateBusy: boolean;
  updateDismissed: string;
  appVersion: string;
  teach: null | "ready" | "recording";
  teachFrames: string[];
  attachments: AttachedFile[];
  vault: VaultSnapshot;
  vaultGroup: string | undefined;
  vaultEditId: string | null | undefined;
  vaultReveal: boolean;
  vaultNaming: boolean;
  vaultShare: string[];
  vaultSharePacks: string[];
  vaultShareOpen: boolean;
  vaultQuery: string;
  localHarness: LocalHarness;
  harnessStatus: HarnessStatusFull | null;
  identities: IdentityRow[];
  identityCatalog: { id: string; label: string }[];
  harnessTab: string | undefined;
  /** Claude desk-login status for the selected cloud desk (iOS parity). */
  claudeAuth: {
    loggedIn?: boolean | undefined;
    email?: string | undefined;
    authMethod?: string | undefined;
    busy?: boolean | undefined;
    /** Browser OAuth opened; waiting for user to paste the code (Electron has no prompt()). */
    awaitingCode?: boolean | undefined;
    signInUrl?: string | undefined;
    error?: string | undefined;
  } | null;
  harnessTests: Record<string, HarnessTest>;
  harnessBannerDismissed: Record<string, boolean>;
  account: AccountState | null;
  accountEmail: string;
  accountBusy: boolean;
  accountError: string;
  cloudDraft: CloudDraftState;
  selectedCloud: string | null;
  cloudPromptLater: boolean;
  cloudSoonOpen: boolean;
  computers: Computer[];
  computerId: string | null | undefined;
  computerStats: Record<string, ComputerStat>;
  computerImages: DeskImage[];
  computerImagesBusy: boolean;
  computerAttach: boolean;
  computerView: string;
  computerSort: string;
  teams: Team[];
  channels: Channel[];
  selectedChannel: string | null;
  deleteBotId: string | null | undefined;
  previewTick: number;
  chatFollow: boolean;
  chatFollowBot: string | null;
  chatExtra: number;
  activityOpen: Record<string, boolean>;
  teamBriefHidden: Record<string, boolean>;
}

/** Anything document.activeElement can be. `disabled` is read off it, and only
 *  form controls have one — Element is still assignable, since it is optional. */
interface FieldEl extends Element {
  disabled?: boolean;
}

/** What a delegated click handler is handed: the event, the element that carried
 *  the data-act, and the act it named. */
interface ActContext {
  el: HTMLElement;
  act: string;
}

/** A delegated action. Returning FALL_THROUGH means "not finished" — see the
 *  note above ACTIONS. */
type ActHandler = (e: MouseEvent, ctx: ActContext) => unknown;

/** The one-line summary the team brief renders for a bot. */
interface BotBrief {
  who: string;
  role: string;
  job: string;
  mission: string;
  now: string;
  team: string;
}

declare global {
  interface Window {
    /** Injected by the Electron preload. Absent in a plain browser tab. */
    sub8Desktop?: {
      version?: () => Promise<string | undefined> | string | undefined;
      checkUpdate?: () => Promise<UpdateInfo | null>;
      onPausing?: (cb: () => void) => void;
    };
  }
}

const $ = <E extends Element = HTMLElement>(sel: string, el: ParentNode = document): E | null => el.querySelector<E>(sel);

const state: AppState = {
  bots: [],
  selected: localStorage.getItem("selectedBot") || null,
  settings: null,
  timezone: "America/New_York",
  modal: null,
  section: "general",
  showComputer: true,
  botEdit: false,
  editingRoutineId: null,
  routineTriggers: [],
  // Cloud routines are per DESK, not per bot, so this caches one desk's list.
  cloudRoutines: { computerId: "", rows: [] },
  schedPop: null,
  confirmDeleteId: null,
  deskSize: "side",
  createFace: "think",
  createHarness: "default",
  createModel: "",
  createName: "",
  createDesc: "",
  createSku: "vm.4g",
  createCloudKind: "bot",
  createCloudPay: false,
  cloudBilling: null,
  cloudBillingError: "",
  paneWidth: Number(localStorage.getItem("paneWidth")) || 420,
  railWidth: Number(localStorage.getItem("railWidth")) || 72,
  plusMenu: false,
  humanControl: false,
  railWake: null,
  ctx: null,
  hasGrokAuth: null,
  grokAuthAsk: false,
  brainSetup: null,
  docker: null,
  dockerBusy: false,
  dockerLog: "",
  dockerInstallFailed: false,
  update: null,
  updateBusy: false,
  updateDismissed: (() => {
    try {
      return localStorage.getItem("sub8.updateDismissed") || "";
    } catch {
      return "";
    }
  })(),
  appVersion: "",
  teach: null,
  teachFrames: [],
  attachments: [],
  vault: { groups: [], accounts: [], grants: {} },
  vaultGroup: "all",
  vaultEditId: null,
  vaultReveal: false,
  vaultNaming: false,
  vaultShare: [],
  vaultSharePacks: [],
  vaultShareOpen: false,
  vaultQuery: "",
  localHarness: {
    ollama: { ok: false, models: [] },
    lmstudio: { ok: false, models: [] },
    grok: { ok: true, models: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"] },
  },
  harnessStatus: null,
  identities: [],
  identityCatalog: [],
  harnessTab: "grok-build",
  claudeAuth: null,
  harnessTests: {},
  harnessBannerDismissed: {},
  account: null,
  accountEmail: "",
  accountBusy: false,
  accountError: "",
  cloudDraft: { computers: [], bots: [] },
  selectedCloud: (localStorage.getItem("selectedCloudBot") || "").replace(/^cloud:/, "cloud-") || null,
  cloudPromptLater: false,
  cloudSoonOpen: false,
  computers: [],
  computerId: null,
  computerStats: {},
  computerImages: [],
  computerImagesBusy: false,
  computerAttach: false,
  computerView: (() => {
    try {
      return localStorage.getItem("sub8.computerView") || "grid";
    } catch {
      return "grid";
    }
  })(),
  computerSort: (() => {
    try {
      return localStorage.getItem("sub8.computerSort") || "name";
    } catch {
      return "name";
    }
  })(),
  teams: [],
  channels: [],
  selectedChannel: null,
  deleteBotId: null,
  previewTick: 0,
  chatFollow: true,
  chatFollowBot: null,
  chatExtra: 0,
  activityOpen: {},
  teamBriefHidden: (() => {
    try {
      return JSON.parse(localStorage.getItem("sub8.teamBriefHidden") || "{}") || {};
    } catch {
      return {};
    }
  })(),
};


function letter(bot: Bot): string {
  return (bot.name || "B").slice(0, 1).toUpperCase();
}

// The cloud-vs-local predicates live in ./cloud-place.mjs and take their world
// as an argument. These wrappers bind this module's `state` so the branch
// points scattered through the shell keep reading the way they always have.
function cloudOn(): boolean {
  return cloudPlace.cloudOn(state);
}

function cloudProductOn(): boolean {
  return cloudPlace.cloudProductOn(state);
}

function cloudComingSoon(): boolean {
  return cloudPlace.cloudComingSoon(state);
}

function cloudBrainReady(bot: Bot | null | undefined): boolean {
  return cloudPlace.cloudBrainReady(state, bot);
}

function cloudBrainHtml(bot: Bot | null | undefined): string {
  const b = bot?.brain || state.cloudDraft?.brain || {};
  const status = b.grokSignedIn
    ? `Grok${b.grokName ? ` · ${escapeHtml(b.grokName)}` : ""}`
    : b.apiKeySet
      ? escapeHtml(b.provider || "API")
      : "";
  return `<div class="cloud-brain">
    <strong>Connect a brain</strong>
    ${status ? `<p class="muted">${status}</p>` : ""}
    <div class="cloud-brain-row">
      <button type="button" class="pill primary" data-act="cloud-brain-grok">Sign in with Grok</button>
    </div>
    <p class="muted" id="cloud-grok-wait" hidden></p>
    <select class="field" id="cloud-brain-provider">
      <option value="spacexai">Grok API</option>
      <option value="claude">Claude</option>
      <option value="openrouter">OpenRouter</option>
      <option value="openai">OpenAI</option>
      <option value="custom">Custom</option>
    </select>
    <input class="field" id="cloud-brain-key" type="password" autocomplete="off" placeholder="API key" />
    <button type="button" class="pill" data-act="cloud-brain-key-save">Save key</button>
  </div>`;
}

function accountLabel(): string {
  const a = state.account;
  if (!a?.signedIn) return "Sign in";
  if (a.handle) return `@${a.handle}`;
  return a.email || "Signed in";
}

function isCloudPlace() {
  return cloudPlace.isCloudPlace(state);
}

function isLiveCloud() {
  return cloudPlace.isLiveCloud(state);
}

function cloudDeskReady(bot: Bot | null | undefined): boolean {
  return cloudPlace.cloudDeskReady(state, bot, viewComputers());
}

function cloudDeskWaitCopy(bot: Bot | null | undefined): string {
  const desk = bot?.desk || viewComputers().find((c) => c.id === bot?.computerId || c.id === bot?.vm?.computerId);
  const st = desk?.status || bot?.vm?.hint || "starting";
  if (st === "attaching" || st === "warming" || st === "starting") return "Desk is starting. Chat opens when it's ready.";
  if (!desk) return "No Cloud desk yet.";
  return "Desk is not ready yet.";
}

function applyCloudComposerGate(bot: Bot | null | undefined): void {
  const wait = $("#desk-wait");
  const form = $<SendForm>("#send");
  const input = form?.q;
  const plus = form?.querySelector<HTMLButtonElement>("[data-act=plus-menu]");
  const mic = form?.querySelector<HTMLButtonElement>("[data-act=dictate]");
  const go = $<HTMLButtonElement>(".composer-go");
  const ready = cloudDeskReady(bot);
  if (ready) {
    if (wait) {
      wait.hidden = true;
      wait.textContent = "";
    }
    if (input) input.disabled = false;
    if (plus) plus.disabled = false;
    if (mic) mic.disabled = false;
    if (go) go.disabled = false;
    form?.classList.remove("desk-wait");
    return;
  }
  const copy = cloudDeskWaitCopy(bot);
  if (wait) {
    wait.hidden = false;
    wait.textContent = copy;
  }
  if (input) {
    input.disabled = true;
    input.placeholder = copy;
  }
  if (plus) plus.disabled = true;
  if (mic) mic.disabled = true;
  if (go) go.disabled = true;
  form?.classList.add("desk-wait");
}

function cloudDeskIdOf(bot: Bot | null | undefined): string {
  return cloudPlace.cloudDeskIdOf(bot);
}

function isCloudChief(bot: Bot | null | undefined): boolean {
  return cloudPlace.isCloudChief(bot);
}

function normalizeCloudRoutine(r: CloudRoutine | null | undefined): Routine | null {
  return cloudPlace.normalizeCloudRoutine(r);
}

// The desk list is shared by every bot on that desk, so only serve it when the
// cached list belongs to the desk currently on screen.
function cloudRoutineRows(bot: Bot | null | undefined): Routine[] {
  const desk = cloudDeskIdOf(bot);
  if (!desk || state.cloudRoutines?.computerId !== desk) return [];
  return state.cloudRoutines.rows || [];
}

let cloudRoutinesInflight: Promise<void> | null = null;

// force: skip the in-flight dedupe. A read triggered by a repaint may share one
// request, but a read that follows a write must not — joining a fetch that was
// issued before the write would land pre-write rows back in the cache.
async function loadCloudRoutines(bot: Bot | null | undefined, { force = false }: { force?: boolean } = {}): Promise<void> {
  const desk = cloudDeskIdOf(bot);
  if (!isCloudPlace() || !desk) return;
  if (cloudRoutinesInflight && !force) return cloudRoutinesInflight;
  const work = (async () => {
    try {
      const out = await api(`/api/cloud/brain/routines?computerId=${encodeURIComponent(desk)}`) as { routines?: CloudRoutine[] } | null;
      state.cloudRoutines = {
        computerId: desk,
        // filter(Boolean) drops exactly the nulls normalizeCloudRoutine returns
        // for a row with no id; the predicate is not one TS can read.
        rows: (out?.routines || []).map(normalizeCloudRoutine).filter(Boolean) as Routine[],
      };
    } catch {
      // A desk that is still warming has no routines to show yet; keep the panel
      // quiet rather than throwing an alert into the render path.
      state.cloudRoutines = { computerId: desk, rows: [] };
    }
  })();
  cloudRoutinesInflight = work;
  try {
    await work;
  } finally {
    if (cloudRoutinesInflight === work) cloudRoutinesInflight = null;
  }
}

function cloudIntervalFromTriggers(triggers: Trigger[] | null | undefined): number | null {
  // The helper types its callback as taking `unknown`. normalizeClientTrigger
  // guards its own argument at runtime, so widening the parameter is honest.
  return cloudPlace.cloudIntervalFromTriggers(triggers, normalizeClientTrigger as (t: unknown) => Trigger | null);
}

function isFieldEl(el: FieldEl | null | undefined): el is HTMLElement {
  return Boolean(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.disabled);
}

function restoreFieldFocus(el: HTMLElement | null | undefined): void {
  if (!isFieldEl(el) || !el.isConnected) return;
  if (document.activeElement === el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function viewBots(): Bot[] {
  return isCloudPlace() ? state.cloudDraft?.bots || [] : state.bots;
}

function botById(id: string | null | undefined): Bot | null {
  if (!id) return null;
  const hit = viewBots().find((b) => b.id === id);
  if (hit) return hit;
  if (isCloudPlace()) return null;
  return state.bots.find((b) => b.id === id) || null;
}

function viewComputers(): Computer[] {
  return isCloudPlace() ? state.cloudDraft?.computers || [] : state.computers;
}

function activeBotId(): string | null {
  return isCloudPlace() ? state.selectedCloud : state.selected;
}

function currentBot(): Bot | null {
  const list = viewBots();
  const id = activeBotId();
  return list.find((b) => b.id === id) || list[0] || null;
}

function editorBot(): Bot | null {
  return isCloudPlace() ? currentBot() : state.bots.find((b) => b.id === state.selected) || null;
}

function persistEditorBot(bot: Bot | null | undefined, body: Record<string, unknown>): void {
  if (!bot || isLiveCloud()) return;
  if (isCloudPlace()) {
    api(`/api/cloud/draft/bots/${bot.id}`, { method: "PATCH", body })
      .then((snap) => {
        if (snap) state.cloudDraft = snap;
        refreshAvatars();
      })
      .catch(() => {});
    return;
  }
  api(`/api/bots/${bot.id}`, { method: "PATCH", body });
}

let liveFrameKey: string | null = null;
let delegated = false;
let cloudVnc = { key: "", up: false, assignedAt: 0, kicks: 0 };
let cloudWatchTimer = 0;
let cloudWatchBusy = false;

function ensureShell(): void {
  if ($("#shell-root")) return;
  // index.html ships <div id="app"> and nothing removes it.
  $("#app")!.innerHTML = `
    <div class="frame" id="shell-root">
      <div class="titlebar" id="titlebar"></div>
      <div id="update-banner" hidden></div>
      <div id="harness-banner" hidden></div>
      <div class="shell">
        <div class="rail" id="rail"></div>
        <div class="main">
          <div class="chat" id="chat"></div>
          <div class="split" id="split" title="Drag to resize"></div>
          <aside class="pane" id="live-pane"></aside>
          <button class="monitor-fab" id="monitor-fab" data-act="expand-pane" title="Show computer" hidden>${iconMonitor()}</button>
        </div>
      </div>
      <div id="modal-host"></div>
      <div id="teach-host" hidden></div>
    </div>`;
  if (!delegated) {
    delegated = true;
    bindDelegated();
  }
}

function needsDesk(bot: Bot | null | undefined): boolean {
  // Boolean(bot) has already short-circuited when bot is nullish.
  return Boolean(bot) && !bot!.vm?.computerId && Boolean(bot!.vm?.detached);
}

function noComputerHtml(bot: Bot): string {
  const free = (state.computers || []).filter((c) => !c.attachedBotId);
  const list = free
    .map(
      (c) =>
        `<button type="button" class="pill" data-act="computer-attach" data-id="${c.id}" data-bot="${bot.id}">${escapeHtml(c.name)}</button>`,
    )
    .join("");
  return `<div class="screen-status desk-empty">
    <div>
      <strong>No computer attached</strong>
      <span>This Bot has no Linux desk. Attach one you already have, or start a new one.</span>
    </div>
    <div class="desk-empty-acts">
      <button type="button" class="pill primary" data-act="desk-start-new">Start a new computer</button>
      ${
        free.length
          ? `<div class="desk-empty-attach"><span class="muted">Or attach</span>${list}</div>`
          : `<span class="muted">No unattached desks. Start a new one, or detach one in Computers.</span>`
      }
    </div>
  </div>`;
}

function cloudDeskRef(bot: Bot | null | undefined): Computer | undefined {
  return bot?.desk || viewComputers().find((c) => c.id === bot?.computerId || c.id === bot?.vm?.computerId) || viewComputers()[0];
}

function cloudViewerStream(bot: Bot | null | undefined, desk: Computer | undefined): string {
  return novncAutoconnectUrl(bot?.vm?.streamUrl || desk?.streamUrl || "", { viewOnly: !state.humanControl });
}

function cloudVncIdentity(bot: Bot | null | undefined, desk: Computer | undefined): string {
  return `${desk?.id || ""}:${desk?.ipv4 || ""}:${bot?.vm?.display || "1"}`;
}

function resetCloudMux(wrap: HTMLElement | null | undefined): void {
  liveFrameKey = null;
  if (!wrap) return;
  delete wrap.dataset.cloudMux;
  wrap.querySelectorAll("iframe.cloud-novnc").forEach((f) => f.remove());
}

function scheduleCloudStreamWatch(ms = 1500): void {
  clearTimeout(cloudWatchTimer);
  cloudWatchTimer = setTimeout(() => {
    watchCloudStream().catch(() => {});
  }, ms);
}

async function probeCloudVnc(bot: Bot | null | undefined, desk: Computer | undefined): Promise<boolean> {
  const id = desk?.id || bot?.computerId || bot?.vm?.computerId || "";
  if (id) {
    try {
      const h = await api(
        `/api/cloud/stream-health?computerId=${encodeURIComponent(id)}&display=${encodeURIComponent(bot?.vm?.display || "1")}`,
      ) as StreamHealth | null;
      if (h && typeof h.ok === "boolean") {
        if (h.ok) return true;
        if (h.reason !== "unknown") return false;
      }
    } catch {
      /* fall through */
    }
  }
  const url = bot?.vm?.streamUrl || desk?.streamUrl || "";
  if (!url) return false;
  try {
    const u = new URL(url);
    u.hash = "";
    u.searchParams.set("_", String(Date.now()));
    await fetch(u.toString(), { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3500) });
    return true;
  } catch {
    return false;
  }
}

async function watchCloudStream(): Promise<void> {
  if (!isCloudPlace()) return;
  if (cloudWatchBusy) {
    scheduleCloudStreamWatch(800);
    return;
  }
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  const bot = currentBot();
  const desk = cloudDeskRef(bot);
  const stream = cloudViewerStream(bot, desk);
  const assigned = Boolean(stream && (desk?.status === "assigned" || desk?.status === "warm"));
  const vncKey = cloudVncIdentity(bot, desk);
  if (!assigned) {
    cloudVnc = { key: "", up: false, assignedAt: 0, kicks: 0 };
    attachLiveFrame(bot);
    return;
  }
  if (cloudVnc.key !== vncKey) cloudVnc = { key: vncKey, up: false, assignedAt: Date.now(), kicks: 0 };
  cloudWatchBusy = true;
  let up = false;
  try {
    up = await probeCloudVnc(bot, desk);
  } finally {
    cloudWatchBusy = false;
  }
  const frame = wrap.querySelector("iframe.cloud-novnc:not(.mux-hidden)");
  const kick = shouldKickCloudFrame({ vncUp: up, hadFrame: Boolean(frame), wasUp: cloudVnc.up });
  cloudVnc.up = up;
  if (kick) {
    cloudVnc.kicks += 1;
    resetCloudMux(wrap);
  }
  attachLiveFrame(bot);
  const waited = Date.now() - (cloudVnc.assignedAt || Date.now());
  if (!cloudVnc.up && waited < 60000) scheduleCloudStreamWatch(1500);
}

function attachLiveFrame(bot: Bot | null | undefined): void {
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  if (isCloudPlace() || bot?.vm?.kind === "cloud-draft") {
    const desk = cloudDeskRef(bot);
    // Teammates share the computer but live on their own display: key and paint
    // by the bot's per-display stream, or every tab shows the chief's screen.
    const stream = cloudViewerStream(bot, desk);
    const key = cloudFrameKey(desk ? { ...desk, streamUrl: stream } : desk);
    const assigned = Boolean(stream && (desk?.status === "assigned" || desk?.status === "warm"));
    const vncKey = cloudVncIdentity(bot, desk);
    if (assigned) {
      if (cloudVnc.key !== vncKey) cloudVnc = { key: vncKey, up: false, assignedAt: Date.now(), kicks: 0 };
    } else {
      cloudVnc = { key: "", up: false, assignedAt: 0, kicks: 0 };
    }
    const waited = cloudVnc.assignedAt ? Date.now() - cloudVnc.assignedAt : 0;
    const ready = shouldMountCloudFrame({ assigned, vncUp: cloudVnc.up, waitedMs: waited });
    if (!assigned) {
      if (liveFrameKey === key && wrap.querySelector(".cloud-desk")) return;
      liveFrameKey = key;
      resetCloudMux(wrap);
      wrap.innerHTML = cloudDeskHtml(bot);
      wrap.dataset.empty = "1";
      return;
    }
    if (!ready) {
      if (liveFrameKey === `${key}:wait` && wrap.querySelector(".cloud-desk")) {
        scheduleCloudStreamWatch(800);
        return;
      }
      liveFrameKey = `${key}:wait`;
      resetCloudMux(wrap);
      wrap.innerHTML = `<div class="screen-status desk-empty cloud-desk">
        <div>
          <strong>Online</strong>
          <span>Desk is up. Connecting to the screen…</span>
        </div>
      </div>`;
      wrap.dataset.empty = "1";
      scheduleCloudStreamWatch(400);
      return;
    }
    delete wrap.dataset.empty;
    const keep = isFieldEl(document.activeElement) ? document.activeElement : null;
    // One live noVNC connection per display, kept connected across tab switches —
    // toggling visibility is instant; remounting reconnects VNC every time.
    if (!wrap.dataset.cloudMux) {
      wrap.innerHTML = `<div class="cloud-desk-live"><div class="cloud-desk-bar"></div><div class="cloud-mux"></div></div>`;
      wrap.dataset.cloudMux = "1";
    }
    const bar = wrap.querySelector(".cloud-desk-bar");
    if (bar) {
      const disp = bot?.vm?.display && bot.vm.display !== ":1" ? ` · screen ${bot.vm.display}` : "";
      // `assigned` above required desk?.status to be "assigned" or "warm", so a
      // desk is on hand by the time this line runs.
      bar.textContent = `${desk!.status} · ${desk!.ram || ""} · ${desk!.ipv4 || ""}${disp}`;
    }
    // The block above writes .cloud-mux whenever dataset.cloudMux is unset, so
    // one of the two paths has put it in the DOM before this read.
    const mux = wrap.querySelector<HTMLElement>(".cloud-mux")!;
    let frame = [...mux.querySelectorAll<HTMLIFrameElement>("iframe.cloud-novnc")].find((f) => f.dataset.stream === stream);
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "cloud-novnc";
      frame.dataset.stream = stream;
      frame.src = stream;
      frame.title = "Cloud desk";
      frame.tabIndex = -1;
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.addEventListener("load", () => {
        if (isFieldEl(document.activeElement) && document.activeElement !== frame) return;
        restoreFieldFocus(keep);
      });
      mux.appendChild(frame);
    }
    frame.dataset.shown = String(Date.now());
    for (const f of mux.querySelectorAll<HTMLIFrameElement>("iframe.cloud-novnc")) f.classList.toggle("mux-hidden", f !== frame);
    // Preload every teammate's screen on this desk so the first tab click is
    // instant too — they connect hidden and wait.
    const deskId = bot?.computerId || bot?.vm?.computerId || "";
    for (const b of viewBots()) {
      if ((b.computerId || b.vm?.computerId) !== deskId) continue;
      const s = novncAutoconnectUrl(b.vm?.streamUrl, { viewOnly: !state.humanControl });
      if (!s || s === stream) continue;
      if ([...mux.querySelectorAll<HTMLIFrameElement>("iframe.cloud-novnc")].some((f) => f.dataset.stream === s)) continue;
      const pf = document.createElement("iframe");
      pf.className = "cloud-novnc mux-hidden";
      pf.dataset.stream = s;
      pf.dataset.shown = "0";
      pf.src = s;
      pf.title = "Cloud desk";
      pf.tabIndex = -1;
      pf.setAttribute("allow", "clipboard-read; clipboard-write");
      mux.appendChild(pf);
    }
    // Cap live connections: drop the least-recently-shown beyond six.
    const frames = [...mux.querySelectorAll<HTMLIFrameElement>("iframe.cloud-novnc")];
    if (frames.length > 6) {
      frames.sort((a, b) => Number(a.dataset.shown || 0) - Number(b.dataset.shown || 0));
      for (const f of frames.slice(0, frames.length - 6)) f.remove();
    }
    liveFrameKey = key;
    paintControlChrome();
    restoreFieldFocus(keep);
    return;
  }
  if (dockerMissing()) {
    liveFrameKey = null;
    wrap.innerHTML = `<div class="screen-status desk-empty">${dockerPaneHtml()}</div>`;
    return;
  }
  // needsDesk() answers false for a nullish bot, so a bot is on hand in here.
  if (needsDesk(bot)) {
    wrap.innerHTML = dockerMissing() ? `<div class="screen-status desk-empty">${dockerPaneHtml()}</div>` : noComputerHtml(bot!);
    liveFrameKey = null;
    if (!dockerMissing()) {
      loadComputers().then(() => {
        const live = state.bots.find((b) => b.id === bot!.id);
        // The if() above has already found the element, and nothing between the
        // two reads can remove it.
        if (needsDesk(live) && $("#screen-wrap")) $("#screen-wrap")!.innerHTML = noComputerHtml(live!);
      });
    }
    return;
  }
  if (!bot?.vm?.novncPort) {
    liveFrameKey = null;
    if (dockerMissing()) {
      wrap.innerHTML = `<div class="screen-status desk-empty">${dockerPaneHtml()}</div>`;
      return;
    }
    wrap.innerHTML = `<div class="screen-status desk-empty"><div><strong>${escapeHtml(vmStatusTitle(bot))}</strong><span>${escapeHtml(
      vmStatusDetail(bot),
    )}</span></div></div>`;
    return;
  }
  const key = frameKey(bot);
  const iframe = wrap.querySelector("iframe");
  if (liveFrameKey !== key || !healthIframeIsCurrent(iframe, bot)) mountLiveFrame(bot);
  paintScreenStatus(bot);
}

function cloudDeskHtml(bot: Bot | null | undefined): string {
  const desk = bot?.desk || viewComputers().find((c) => c.id === bot?.computerId || c.id === bot?.vm?.computerId) || viewComputers()[0];
  if (!desk && !bot) {
    return `<div class="screen-status desk-empty cloud-desk">
      <div>
        <strong>No Cloud desk yet</strong>
        <span>Always-on Linux. If the pool is empty, this creates a DigitalOcean droplet and builds the image on first boot.</span>
        <div class="desk-actions" style="margin-top:12px;justify-content:center">
          <button class="pill primary" data-act="cloud-new-computer" type="button">New Cloud computer</button>
        </div>
      </div>
    </div>`;
  }
  const stream = novncAutoconnectUrl(bot?.vm?.streamUrl || desk?.streamUrl || "", { viewOnly: !state.humanControl });
  const ready = stream && (desk?.status === "assigned" || desk?.status === "warm");
  if (ready) {
    const disp = bot?.vm?.display && bot.vm.display !== ":1" ? ` · screen ${escapeHtml(bot.vm.display)}` : "";
    // `ready` required desk?.status to be "assigned" or "warm".
    return `<div class="cloud-desk-live">
      <div class="cloud-desk-bar">${escapeHtml(desk!.status)} · ${escapeHtml(desk!.ram || "")} · ${escapeHtml(desk!.ipv4 || "")}${disp}</div>
      <iframe class="cloud-novnc" src="${escapeHtml(stream)}" title="Cloud desk" tabindex="-1" allow="clipboard-read; clipboard-write"></iframe>
    </div>`;
  }
  return `<div class="screen-status desk-empty cloud-desk">
    <div>
      <strong>${escapeHtml(desk?.status || "warming")}</strong>
      <span>${desk?.ipv4 ? escapeHtml(desk.ipv4) + " — building the desk image. This page updates on its own." : "DigitalOcean is creating the droplet. First boot installs Docker and builds the Sub8 image."}</span>
      ${desk?.error ? `<span class="muted">${escapeHtml(desk.error)}</span>` : ""}
    </div>
  </div>`;
}

function vmStatusTitle(bot: Bot | null | undefined): string {
  if (bot?.vm?.status === "error" && bot.vm.error && !isTransientVmError(bot.vm.error)) return "Computer needs attention";
  return "Setting up the computer";
}

function isTransientVmError(msg: unknown): boolean {
  return /app install|wget|apt|PackageKit|Unable to fetch|warming|Still setting|already in use|Conflict/i.test(String(msg || ""));
}

function vmStatusDetail(bot: Bot | null | undefined): string {
  const setup = bot?.vm?.setup;
  if (setup && setup.ready === false && setup.step) {
    return `Setting up the computer (${setup.step}/${setup.total}): ${setup.label}`;
  }
  const hint = String(bot?.vm?.hint || "").trim();
  if (hint) return hint;
  if (isTransientVmError(bot?.vm?.error)) return "Installing Chrome and tools. This can take a minute on a new computer.";
  if (bot?.vm?.error) return bot.vm.error;
  if (bot?.vm?.status === "starting") return "Waiting for the desktop…";
  if (bot?.vm?.container && !bot?.vm?.novncPort) return "Waiting for this Bot's screen…";
  return "Computer not assigned yet";
}

function paintScreenStatus(bot: Bot | null | undefined): void {
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  const iframe = wrap.querySelector("iframe");
  const st = bot?.vm?.status || "";
  // st is only "error" when bot.vm.status is, so both are on hand here.
  const hardErr = st === "error" && bot!.vm!.error && !isTransientVmError(bot!.vm!.error);
  const boot = Boolean(bot?.vm?.setup && bot.vm.setup.ready === false);
  const installing = st === "starting" || boot;
  wrap.querySelector(".screen-status:not(.desk-empty)")?.remove();
  let chip = wrap.querySelector<HTMLElement>(".screen-chip");
  if (!iframe) {
    chip?.remove();
    return;
  }
  if (!installing && !hardErr) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "screen-chip";
    wrap.appendChild(chip);
  }
  chip.textContent = vmStatusDetail(bot) || "Starting…";
  chip.classList.toggle("err", Boolean(hardErr));
}

function dockerMissing(): boolean | null {
  return state.docker && state.docker.ok === false;
}

function dockerStuck(): boolean {
  return Boolean(state.docker?.stuck);
}

function dockerPlatform(): string {
  return String(state.docker?.platform || "").toLowerCase();
}

function dockerIsWindows(): boolean {
  return dockerPlatform() === "win32" || /Windows/i.test(navigator.userAgent || "");
}

function dockerIsLinux(): boolean {
  if (dockerIsWindows()) return false;
  return dockerPlatform() === "linux" || (/Linux/i.test(navigator.userAgent || "") && !/Android/i.test(navigator.userAgent || ""));
}

function dockerInstalling(): boolean {
  return state.dockerBusy === "install" || Boolean(state.docker?.installing);
}

function dockerKind(): string {
  if (!dockerMissing()) return "";
  if (state.dockerBusy || state.docker?.installing) return "preparing";
  if (state.docker?.cli === false) return "missing";
  if (dockerStuck()) return "stuck";
  return "starting";
}

function dockerMissingCopy(): string {
  if (dockerIsWindows()) return "Sub8 will install Docker Desktop so each bot can have a computer.";
  if (dockerIsLinux()) return "Sub8 will install Docker Engine so each bot can have a computer.";
  return "Sub8 will install a Docker engine (Colima on a Mac — not Docker Desktop) so each bot can have a computer.";
}

function dockerPaneLog(): string {
  const log = String(state.docker?.installLog || state.dockerLog || "").trim();
  if (!log) return "";
  return `<pre class="desk-docker-log">${escapeHtml(log.slice(-4000))}</pre>`;
}

function dockerPaneHtml(): string {
  const kind = dockerKind() || "starting";
  const hint = String(state.docker?.hint || "").trim();
  const installing = dockerInstalling();
  const titles: Record<string, string> = {
    preparing: installing ? "Installing Docker…" : "Starting Docker…",
    starting: "Waiting for Docker…",
    stuck: "Can't reach Docker",
    missing: "Docker is not installed",
  };
  const details: Record<string, string> = {
    preparing: installing
      ? hint || "Downloading and starting a Docker engine. This can take a few minutes."
      : "Checking the engine. The desktop will show here when it's ready.",
    starting: hint || "Docker is installed but not ready yet. This area updates on its own.",
    stuck: hint || "Docker stopped answering. Desks are probably still running.",
    missing: state.dockerInstallFailed && hint ? hint : dockerMissingCopy(),
  };
  const busy = Boolean(state.dockerBusy);
  const startLabel = busy ? "Starting…" : kind === "stuck" ? "Recover Docker" : "Start Docker";
  const start =
    kind === "missing" || installing
      ? ""
      : `<button type="button" class="pill primary" data-act="recover-docker" ${busy ? "disabled" : ""}>${escapeHtml(startLabel)}</button>`;
  const showInstall = kind === "missing" || kind === "starting" || installing || state.docker?.cli === false;
  const installLabel = installing || state.dockerBusy === "install" ? "Installing…" : "Install Docker";
  const install = showInstall
    ? `<button type="button" class="pill ${kind === "missing" || installing ? "primary" : ""}" data-act="install-docker" ${busy ? "disabled" : ""}>${escapeHtml(installLabel)}</button>`
    : "";
  const desktop =
    dockerIsWindows() || state.dockerInstallFailed
      ? `<button type="button" class="pill" data-act="docker-desktop-docs">Get Docker Desktop</button>`
      : "";
  return `<div class="desk-docker" data-docker="${kind}">
    <strong>${titles[kind]}</strong>
    <span>${escapeHtml(details[kind])}</span>
    ${dockerPaneLog()}
    <span class="muted">${installing ? "Installing in the app — you can leave this pane open." : "Checking automatically."}</span>
    <div class="desk-docker-acts">${start}${install}${desktop}</div>
  </div>`;
}

function dockerMissingHtml(): string {
  return dockerPaneHtml();
}

function dockerInstallUrl(): string {
  if (dockerIsWindows()) return "https://docs.docker.com/desktop/setup/install/windows-install/";
  if (dockerIsLinux()) return "https://docs.docker.com/engine/install/";
  return "https://docs.docker.com/desktop/setup/install/mac-install/";
}

const OFFICIAL_SITE = "https://sub8.bot";

function releasePageUrl(): string {
  return state.update?.releaseUrl || "https://github.com/sub8bot/Sub8/releases";
}

function downloadUrl(): string {
  return state.update?.downloadUrl || "";
}

function siteUrl(): string {
  return state.update?.siteUrl || OFFICIAL_SITE;
}

function dismissedThisUpdate(): boolean {
  const latest = String(state.update?.latestVersion || "").trim();
  return Boolean(latest && state.updateDismissed === latest);
}

function paintUpdateBanner(): void {
  let host = $("#update-banner");
  if (!host) {
    const bar = $("#titlebar");
    host = document.createElement("div");
    host.id = "update-banner";
    if (bar?.parentNode) bar.after(host);
    else document.body.appendChild(host);
  }
  const u = state.update;
  if (!u?.updateAvailable || dismissedThisUpdate()) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  const file = downloadUrl();
  const label = u.downloadName ? `Download ${u.downloadName}` : "Download";
  host.hidden = false;
  host.innerHTML = `<div class="update-strip">
    <span>Sub8 ${escapeHtml(u.latestVersion || "")} is available
    <span class="muted">(you have ${escapeHtml(u.currentVersion || "")})</span></span>
    ${file ? `<a class="update-link" href="${escapeHtml(file)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : ""}
    <a class="update-link" href="${escapeHtml(siteUrl())}" target="_blank" rel="noopener">sub8.bot</a>
    <button type="button" class="update-x" data-act="dismiss-update" title="Dismiss">×</button>
  </div>`;
}

async function runningAppVersion(): Promise<string> {
  try {
    const v = await window.sub8Desktop?.version?.();
    if (v) return String(v);
  } catch {
    /* unpackaged or no handler */
  }
  return state.appVersion || "";
}

async function checkForUpdate({ silent = true }: { silent?: boolean } = {}): Promise<UpdateInfo | null> {
  try {
    const desktop = window.sub8Desktop;
    const current = (await runningAppVersion()) || state.appVersion || "";
    let info = await api(`/api/update${current ? `?current=${encodeURIComponent(current)}` : ""}`) as UpdateInfo;
    if (current) info = { ...info, currentVersion: current };
    if (desktop?.checkUpdate) {
      const native = await Promise.race([
        desktop.checkUpdate().catch(() => null),
        new Promise<UpdateInfo | null>((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]);
      if (native?.currentVersion) info.currentVersion = native.currentVersion;
      if (native?.updateAvailable && native.latestVersion && info.downloadUrl) {
        info = {
          ...info,
          latestVersion: native.latestVersion,
          updateAvailable: true,
          error: null,
        };
      }
      if (!info.downloadUrl) info.updateAvailable = false;
    }
    state.update = { ...info, justChecked: !silent };
    if (info.currentVersion) state.appVersion = info.currentVersion;
    paintUpdateBanner();
    if (state.modal === "settings") paintModal();
    return info;
  } catch (err) {
    state.update = {
      currentVersion: state.appVersion || "",
      updateAvailable: false,
      error: (err as CaughtError).message,
      justChecked: !silent,
    };
    if (!silent && state.modal === "settings") paintModal();
    return state.update;
  }
}

function openExternal(url: string | undefined): void {
  if (!url) return;
  window.open(url, "_blank", "noopener");
}

function openDownload(): void {
  openExternal(downloadUrl() || releasePageUrl());
  if (state.modal) {
    state.modal = null;
    render();
  }
}

function openOfficialSite(): void {
  openExternal(siteUrl());
  if (state.modal) {
    state.modal = null;
    render();
  }
}

function dismissUpdateBanner(): void {
  const latest = String(state.update?.latestVersion || "").trim();
  if (latest) {
    state.updateDismissed = latest;
    try {
      localStorage.setItem("sub8.updateDismissed", latest);
    } catch {
      /* ignore quota / private mode */
    }
  }
  paintUpdateBanner();
}

function paintDockerGate(): void {
  let host = $("#docker-gate");
  if (host) {
    host.innerHTML = "";
    host.hidden = true;
  }
  if (isCloudPlace()) {
    attachLiveFrame(currentBot());
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) attachLiveFrame(bot);
}

function streamUrl(bot: Bot, { bust = false }: { bust?: boolean } = {}): string {
  const q = `autoconnect=true&reconnect=true&reconnect_delay=1500&resize=scale`;
  const hash = `autoconnect=true&reconnect=true&resize=scale`;
  // Every caller checks bot.vm.novncPort before asking for a URL.
  return `http://127.0.0.1:${bot.vm!.novncPort}/?${q}${bust ? `&t=${Date.now()}` : ""}#${hash}`;
}

const lastGoodScreen = new Map<string, string>();

function bindStill(img: HTMLImageElement | null | undefined, botId: string): void {
  if (!img) return;
  img.addEventListener("load", () => {
    if (img.naturalWidth > 1) {
      lastGoodScreen.set(botId, img.currentSrc || img.src);
      img.hidden = false;
      img.classList.remove("broken");
    }
  });
  img.addEventListener("error", () => {
    const keep = lastGoodScreen.get(botId);
    if (keep && img.src !== keep) {
      img.src = keep;
      return;
    }
    img.removeAttribute("src");
    img.hidden = true;
    img.classList.add("broken");
  });
}

async function refreshStill(img: HTMLImageElement | null | undefined, botId: string | null | undefined): Promise<void> {
  if (!img || !botId) return;
  try {
    const res = await fetch(`/api/bots/${botId}/screen?t=${Date.now()}`);
    if (!res.ok) throw new Error("no still");
    const blob = await res.blob();
    if (!blob.size || blob.size < 80) throw new Error("empty still");
    const url = URL.createObjectURL(blob);
    const prev = lastGoodScreen.get(botId);
    lastGoodScreen.set(botId, url);
    img.src = url;
    img.hidden = false;
    img.classList.remove("broken", "hidden");
    if (prev && prev.startsWith("blob:") && prev !== url) {
      setTimeout(() => URL.revokeObjectURL(prev), 4000);
    }
  } catch {
    const keep = lastGoodScreen.get(botId);
    if (keep) {
      if (img.src !== keep) img.src = keep;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
}

function screenStill(wrap: HTMLElement | null | undefined): HTMLImageElement | null | undefined {
  return wrap?.querySelector(".screen-still");
}

function holdStill(wrap: HTMLElement | null | undefined, botId: string | null | undefined): HTMLImageElement | null | undefined {
  const still = screenStill(wrap);
  if (!still || !botId) return still;
  still.classList.remove("hidden");
  still.hidden = false;
  const keep = lastGoodScreen.get(botId);
  if (keep && still.src !== keep) still.src = keep;
  refreshStill(still, botId);
  return still;
}

let connectingTimer = 0;
function beginStreamWait(wrap: HTMLElement | null | undefined, botId: string, { reset = false }: { reset?: boolean } = {}): void {
  if (!wrap) return;
  holdStill(wrap, botId);
  if (reset || !wrap.dataset.awaiting) wrap.dataset.awaiting = String(Date.now());
  delete wrap.dataset.streamReady;
  if (reset) delete wrap.dataset.iframeLoaded;
  wrap.querySelector(".screen-connecting")?.remove();
  clearTimeout(connectingTimer);
  const downSince = Number(wrap.dataset.awaiting || Date.now());
  connectingTimer = setTimeout(() => settleStreamWait(wrap), Math.max(0, CONNECTING_AFTER_MS - (Date.now() - downSince)));
}

function markIframeLoaded(wrap: HTMLElement | null | undefined): void {
  if (!wrap) return;
  wrap.dataset.iframeLoaded = "1";
  settleStreamWait(wrap);
}

function settleStreamWait(wrap: HTMLElement | null | undefined): void {
  if (!wrap) return;
  const downSince = Number(wrap.dataset.awaiting || 0);
  const now = Date.now();
  const loaded = wrap.dataset.iframeLoaded === "1";
  const still = screenStill(wrap);
  if (loaded) {
    wrap.dataset.streamReady = "1";
    wrap.querySelector(".screen-connecting")?.remove();
    still?.classList.add("hidden");
    if (!downSince || now - downSince >= CONNECTING_AFTER_MS) delete wrap.dataset.awaiting;
    return;
  }
  if (!loaded && shouldShowConnecting({ downSince, now })) {
    if (!wrap.querySelector(".screen-connecting")) {
      const chip = document.createElement("div");
      chip.className = "screen-connecting";
      chip.textContent = "Connecting…";
      wrap.appendChild(chip);
    }
  }
}

function mountLiveFrame(bot: Bot | null | undefined): void {
  const wrap = $("#screen-wrap");
  if (!wrap || !bot?.vm?.novncPort) return;
  const key = frameKey(bot);
  liveFrameKey = key;
  delete wrap.dataset.empty;
  const keep = lastGoodScreen.get(bot.id) || "";
  wrap.innerHTML = `<img class="screen-still${keep ? "" : " hidden"}" alt="" ${
    keep ? `src="${keep}"` : ""
  } /><iframe data-key="${key}" src="${streamUrl(bot)}" allow="clipboard-read; clipboard-write"></iframe>`;
  const iframe = wrap.querySelector("iframe");
  const still = wrap.querySelector<HTMLImageElement>(".screen-still");
  bindStill(still, bot.id);
  // The innerHTML two lines up always writes that <img>.
  if (keep) still!.hidden = false;
  beginStreamWait(wrap, bot.id, { reset: true });
  const label = $("#screen-label");
  iframe?.addEventListener("load", () => {
    if (wrap.querySelector("iframe") !== iframe) return;
    if (state.selected !== bot.id || !healthIframeIsCurrent(iframe, bot)) return;
    if (label) label.textContent = `${bot.name}'s screen`;
    const live = state.bots.find((b) => b.id === bot.id) || bot;
    paintScreenStatus(live);
    markIframeLoaded(wrap);
  });
  iframe?.addEventListener("error", () => {
    if (state.selected !== bot.id) return;
    scheduleStreamRetry(bot, 1600);
  });
  paintControlChrome();
}

let streamRetry = 0;
function scheduleStreamRetry(bot: Bot, ms: number): void {
  clearTimeout(streamRetry);
  streamRetry = setTimeout(() => {
    if (state.selected !== bot.id || !bot.vm?.novncPort) return;
    const wrap = $("#screen-wrap");
    const iframe = wrap?.querySelector("iframe");
    if (iframe && healthIframeIsCurrent(iframe, bot)) {
      beginStreamWait(wrap, bot.id, { reset: true });
      iframe.src = streamUrl(bot, { bust: true });
      return;
    }
    liveFrameKey = null;
    mountLiveFrame(bot);
  }, ms);
}

function rememberSelected(id: string | null | undefined): void {
  if (isCloudPlace()) {
    // Keep ids in viewBots/cloudDraft and the id assigned after a live snapshot.
    state.selectedCloud = id || null;
    try {
      if (id) localStorage.setItem("selectedCloudBot", id);
      else localStorage.removeItem("selectedCloudBot");
    } catch {
      /* ignore */
    }
    return;
  }
  state.selected = id || null;
  try {
    if (id) localStorage.setItem("selectedBot", id);
    else localStorage.removeItem("selectedBot");
  } catch {
    /* ignore */
  }
}

function unionClientMessages(a: Message[] = [], b: Message[] = []): Message[] {
  const byId = new Map();
  for (const m of a) if (m?.id) byId.set(m.id, m);
  for (const m of b) {
    if (!m?.id) continue;
    const was = byId.get(m.id);
    if (was?.kind === "choices" && was.pending === false && m.kind === "choices" && m.pending !== false) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

const forgottenBots = new Set<string>();
const forgottenMessages = new Set<string>();

function keepCountFor(bot: Bot | null | undefined): number {
  return bot?.id === state.selected ? 300 : 40;
}

function trimBotMessages(bot: Bot | null | undefined): void {
  if (!bot?.messages || bot.messages.length <= keepCountFor(bot)) return;
  const cap = keepCountFor(bot);
  const pending = bot.messages.filter((m) => (m.kind === "choices" || m.kind === "secret-request") && m.pending !== false);
  const body = bot.messages.filter((m) => !(m.kind === "choices" && m.pending !== false));
  const kept = body.slice(-cap);
  const extra = pending.filter((p) => !kept.some((k) => k.id === p.id));
  bot.messages = extra.length ? [...kept, ...extra] : kept;
  bot.messagesTruncated = true;
}

function adoptBot(next: Bot): Bot {
  if (!next?.id || forgottenBots.has(next.id)) return next;
  const i = state.bots.findIndex((b) => b.id === next.id);
  if (i < 0) {
    next.messages = Array.isArray(next.messages) ? next.messages : [];
    trimBotMessages(next);
    state.bots.push(next);
    return next;
  }
  // i came from findIndex and the i < 0 case returned above, so every read of
  // state.bots[i] in this block is in bounds.
  const prev = state.bots[i]!;
  next.messages = unionClientMessages(next.messages, prev.messages).filter(
    (m) => !forgottenMessages.has(`${next.id}:${m.id}`),
  );
  state.bots[i] = { ...prev, ...next, messages: next.messages };
  if (typeof next.busy === "boolean") state.bots[i]!.busy = next.busy;
  if (next.messagesTruncated || prev.messagesTruncated) state.bots[i]!.messagesTruncated = true;
  trimBotMessages(state.bots[i]);
  return state.bots[i]!;
}

function syncBots(incoming: Bot[]): void {
  const list = Array.isArray(incoming) ? incoming : [];
  const seen = new Set(list.map((b) => b.id).filter(Boolean));
  for (const id of seen) forgottenBots.delete(id);
  for (const b of list) adoptBot(b);
  state.bots = state.bots.filter((b) => seen.has(b.id));
  if (state.selected && !seen.has(state.selected)) {
    rememberSelected(state.bots.find((b) => !b.hidden)?.id || null);
  }
}

const cloudTurns = new Map<string, { turnId?: string | undefined; computerId?: string | undefined }>();
let cloudWatchGen = 0;

async function stopTurn(): Promise<void> {
  if (isCloudPlace()) {
    // Parity with local: Stop halts the whole team — every queued and running
    // turn on the desk, all displays.
    const bot = currentBot();
    if (!bot) return;
    const computerId = bot.computerId || bot.vm?.computerId || cloudTurns.get(bot.id)?.computerId;
    for (const b of viewBots()) {
      if ((b.computerId || b.vm?.computerId) === computerId) {
        b.busy = false;
        cloudTurns.delete(b.id);
      }
    }
    paintChat(bot);
    if (computerId) {
      await api("/api/cloud/brain/abort", { method: "POST", body: { computerId, all: true } }).catch(() => {});
    }
    return;
  }
  const id = state.selected;
  if (!id) return;
  const bot = state.bots.find((b) => b.id === id);
  const ids = new Set([id]);
  const team = teamOf(bot);
  for (const b of teamBots(team)) ids.add(b.id);
  for (const bid of ids) {
    const b = state.bots.find((x) => x.id === bid);
    if (b) b.busy = false;
  }
  if (bot) paintChat(bot);
  await Promise.all([...ids].map((bid) => api(`/api/bots/${bid}/stop`, { method: "POST", body: {} }).catch(() => {})));
}

async function loadBotHistory(id: string | null | undefined): Promise<void> {
  if (!id || isCloudPlace()) return;
  try {
    const bot = await api(`/api/bots/${id}?tail=120`) as Bot;
    adoptBot(bot);
    if (state.selected === id && !isCloudPlace()) {
      state.chatExtra = 0;
      paintChat(state.bots.find((b) => b.id === id));
      refreshAvatars();
    }
  } catch {
    /* keep whatever we already have */
  }
}

const CHAT_PAGE = 50;

function chatWindowSize(extra: number): number {
  return CHAT_PAGE + (Number(extra) || 0) * CHAT_PAGE;
}

function restoreChatScroll(thread: HTMLElement | null | undefined, prevHeight: number, prevTop: number): void {
  if (!thread) return;
  thread.scrollTop = Math.max(0, thread.scrollHeight - prevHeight + prevTop);
}

async function loadOlderChat(): Promise<void> {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || bot._loadingOlder) return;
  const thread = $("#thread");
  const allRows = (bot.messages || []).filter((m) => !m.hidden && m.role !== "tool");
  const hiddenLocal = Math.max(0, allRows.length - chatWindowSize(state.chatExtra));
  const prevHeight = thread?.scrollHeight || 0;
  const prevTop = thread?.scrollTop || 0;
  state.chatFollow = false;

  if (hiddenLocal > 0) {
    state.chatExtra += 1;
    paintChat(bot);
    refreshAvatars();
    restoreChatScroll(thread, prevHeight, prevTop);
    return;
  }

  const oldest = allRows[0];
  bot._loadingOlder = true;
  const btn = thread?.querySelector<HTMLButtonElement>("[data-act=chat-more]");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading…";
  }
  try {
    const q = oldest?.id
      ? `before=${encodeURIComponent(oldest.id)}&limit=80${oldest.ts ? `&beforeTs=${encodeURIComponent(String(oldest.ts))}` : ""}`
      : "tail=200";
    const pack = await api(`/api/bots/${bot.id}?${q}`) as { messages?: Message[]; hasMore?: boolean };
    const incoming = Array.isArray(pack.messages) ? pack.messages : [];
    if (incoming.length) {
      const before = (bot.messages || []).length;
      bot.messages = unionClientMessages(incoming, bot.messages);
      bot.messagesTruncated = pack.hasMore === true || (pack.hasMore !== false && bot.messages.length > before);
      state.chatExtra += 1;
    } else {
      bot.messagesTruncated = false;
    }
    paintChat(bot);
    refreshAvatars();
    if (incoming.length) restoreChatScroll(thread, prevHeight, prevTop);
  } catch {
    paintChat(bot);
  } finally {
    bot._loadingOlder = false;
  }
}

function namedBubble(m: Message, assistant: boolean): string {
  const name = escapeHtml(m.speakerName || "Bot");
  const role = m.speakerRole ? ` · ${escapeHtml(m.speakerRole)}` : "";
  const aid = m.speakerId && m.speakerId !== "user" && m.speakerId !== "teammate" ? m.speakerId : "";
  const who = aid ? viewBots().find((b) => b.id === aid) : null;
  const letter = (m.speakerName || who?.name || "?").slice(0, 1).toUpperCase();
  const color = who?.color || "#a1a1aa";
  const avatar = aid
    ? `<span class="msg-ava msg-ava-ink" style="background:${escapeHtml(color)}">${escapeHtml(letter)}</span>`
    : `<span class="msg-ava msg-ava-empty"></span>`;
  const raw = String(m.content || "").trim();
  const first = (raw.split("\n").find((l) => l.trim()) || "").replace(/^To [^:]+:\s*/i, "");
  const fromWorker = m.speakerRole === "worker" || Boolean(m.toId);
  const openBtn = aid && aid !== state.selected
    ? `<button type="button" class="mate-open" data-act="team-tab" data-id="${escapeHtml(aid)}">Open ${name}</button>`
    : "";
  const body = fromWorker
    ? `<div class="bubble mate-card">${escapeHtml(first.slice(0, 140))}${first.length > 140 ? "…" : ""}
        ${openBtn}</div>`
    : `<div class="bubble">${assistant ? formatChatText(m.content) : escapeHtml(m.content)}${openBtn}</div>`;
  return `<div class="msg ${assistant ? "asst" : "mate"}" data-mid="${escapeHtml(m.id || "")}">
    ${avatar}
    <div class="msg-col">
      <div class="msg-meta">${name}${role}</div>
      ${body}
    </div>
  </div>`;
}

function paintChat(bot: Bot | null | undefined): void {
  const thread = $("#thread");
  if (!thread || !bot) return;
  if (isCloudPlace() && bot.place !== "cloud") return;
  const typing = document.activeElement;
  if (thread.contains(typing) && isFieldEl(typing)) {
    const mid = typing.classList?.contains("choice-custom") ? typing.dataset.mid : "";
    // `mid` is a string, so the && can also answer "" — which has no `pending`
    // and reads as undefined, exactly as it did before.
    const focusedCard: Message | "" | undefined = mid && (bot.messages || []).find((m) => m.id === mid);
    // Keep the open card's input while they type (tool ticks would wipe it).
    // Once that card is answered, fall through so the question actually closes.
    if (!mid || (focusedCard as Message | undefined)?.pending !== false) {
      const go = $<HTMLButtonElement>(".composer-go");
      const halt = $<HTMLButtonElement>(".composer [data-act=stop-turn]");
      if (go) go.hidden = false;
      if (halt) halt.hidden = !bot.busy;
      return;
    }
  }
  bindActivityFold(thread);
  if (!Array.isArray(bot.messages)) bot.messages = [];
  if (state.chatFollowBot !== bot.id) {
    state.chatFollowBot = bot.id;
    state.chatFollow = true;
    state.chatExtra = 0;
  }
  const allRows = bot.messages.filter((m) => !m.hidden && m.role !== "tool" && !isTransientChatStatus(m));
  const windowSize = chatWindowSize(state.chatExtra);
  const hidden = Math.max(0, allRows.length - windowSize);
  const rows = hidden ? allRows.slice(-windowSize) : allRows;
  if (!allRows.length && !bot.busy) {
    thread.innerHTML = isCloudPlace() && !cloudBrainReady(bot)
      ? cloudBrainHtml(bot)
      : `<div class="empty">Message ${escapeHtml(bot.name)} to put it to work.</div>`;
    return;
  }
  const html: string[] = [];
  if (hidden || bot.messagesTruncated) {
    html.push(`<button type="button" class="chat-more" data-act="chat-more">Load earlier messages</button>`);
  }
  const pendingChoices: Message[] = [];
  let liveActivity = false;
  // Every rows[i] below sits under the i < rows.length guard of this loop.
  for (let i = 0; i < rows.length; ) {
    const m = rows[i]!;
    if (m.kind === "choices" || m.kind === "secret-request") {
      if (m.pending !== false) pendingChoices.push(m);
      else html.push(renderChoiceCard(m));
      i += 1;
      continue;
    }
    if (codeAgentFromMsg(m)) {
      html.push(renderCodeAgentCard(m));
      i += 1;
      continue;
    }
    if (m.role === "user") {
      const fromMate = m.speakerId && m.speakerId !== "user" && m.speakerName;
      html.push(fromMate ? namedBubble(m, false) : `<div class="bubble user" data-mid="${escapeHtml(m.id || "")}">${escapeHtml(m.content)}</div>`);
      i += 1;
      continue;
    }
    if (m.kind === "think" || m.kind === "tool" || m.role === "activity") {
      const batch: Message[] = [];
      while (i < rows.length && (rows[i]!.kind === "think" || rows[i]!.kind === "tool" || rows[i]!.role === "activity")) {
        const next = rows[i]!;
        const gap = (Number(next.ts) || 0) - (Number(batch.at(-1)?.ts) || Number(next.ts) || 0);
        if (batch.length && (gap > 45_000 || batch.length >= 80)) break;
        batch.push(next);
        i += 1;
      }
      const live = Boolean(bot.busy && i >= rows.length);
      liveActivity = live;
      html.push(renderActivity(batch, live));
      continue;
    }
    if (String(m.content || "").trim()) {
      html.push(m.speakerName ? namedBubble(m, true) : `<div class="bubble" data-mid="${escapeHtml(m.id || "")}">${formatChatText(m.content)}</div>`);
    }
    i += 1;
  }
  if (bot.busy && !liveActivity) {
    html.push(
      `<div class="working" role="status" aria-live="polite"><span class="working-dot" aria-hidden="true"></span>Working…</div>`,
    );
  }
  for (const card of pendingChoices) html.push(renderChoiceCard(card));
  const brainCard = isCloudPlace() && !cloudBrainReady(bot) ? cloudBrainHtml(bot) : "";
  thread.innerHTML = brainCard + html.join("");
  if (state.chatFollow) thread.scrollTop = thread.scrollHeight;
  const go = $<HTMLButtonElement>(".composer-go");
  const halt = $<HTMLButtonElement>(".composer [data-act=stop-turn]");
  if (go) go.hidden = false;
  if (halt) halt.hidden = !bot.busy;
}

function activityKey(m: Message): string {
  if (m.kind === "think") return "think";
  const act = m.action || m.name || "";
  if (act === "key" || act === "type") return `${act}:${m.summary || ""}`;
  return act || m.summary || "work";
}

function activityFoldKey(batch: Message[]): string {
  return String(batch[0]?.id || batch.map((m) => m.id).filter(Boolean).join(",") || "activity");
}

function activitySummary(tools: Message[], partCount: number): string {
  const n = tools.length;
  if (!n) return "Thought";
  if (partCount <= 1) {
    const first = tools[0]!;
    const label = first.summary || first.action || first.name || "Working";
    return n > 1 ? `${label} ×${n}` : label;
  }
  return `${n} steps`;
}

function bindActivityFold(thread: HTMLElement | null): void {
  if (!thread || thread.dataset.foldBound) return;
  thread.dataset.foldBound = "1";
  thread.addEventListener(
    "toggle",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLDetailsElement) || !el.classList.contains("tool-fold")) return;
      const key = el.dataset.fold;
      if (key) state.activityOpen[key] = el.open;
    },
    true,
  );
}

function renderActivity(batch: Message[], openLast: boolean): string {
  const thoughts = batch.filter((m) => m.kind === "think");
  const tools = batch.filter((m) => m.kind !== "think");
  const order: string[] = [];
  const byKey = new Map<string, Message[]>();
  for (const m of tools) {
    const key = activityKey(m);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(m);
  }
  const parts: string[] = [];
  for (const key of order) {
    const items = byKey.get(key) || [];
    const first = items[0];
    if (!first) continue;
    const n = items.length;
    const label = first.summary || first.action || first.name || "Working";
    const text = n > 1 ? `${label} ×${n}` : label;
    parts.push(`<div class="tool-row">${toolIcon(first.action || first.name)}<span>${escapeHtml(text)}</span></div>`);
  }
  if (thoughts.length) {
    const body = thoughts.map((t) => t.content).filter(Boolean).at(-1) || "";
    parts.push(`<details class="thought"${openLast ? " open" : ""}>
      <summary>Thought</summary>
      <div class="thought-body">${formatChatText(body)}</div>
    </details>`);
  }
  const mids = batch.map((m) => m.id).filter(Boolean).join(",");
  const fold = parts.length > 1 || (thoughts.length > 0 && tools.length > 0);
  if (!fold) {
    return `<div class="tool-list" data-mids="${escapeHtml(mids)}">${parts.join("")}</div>`;
  }
  const key = activityFoldKey(batch);
  const open = state.activityOpen[key] === true;
  const label = activitySummary(tools, order.length);
  const mark = openLast
    ? `<span class="working-dot" aria-hidden="true"></span>`
    : toolIcon("computer");
  return `<details class="tool-fold${openLast ? " is-live" : ""}"${open ? " open" : ""} data-fold="${escapeHtml(key)}" data-mids="${escapeHtml(mids)}">
    <summary class="tool-fold-sum"${openLast ? ` role="status" aria-live="polite"` : ""}>${mark}<span>${escapeHtml(label)}</span></summary>
    <div class="tool-list">${parts.join("")}</div>
  </details>`;
}

function toolIcon(action: string | undefined): string {
  const a = String(action || "");
  const svg = (d: string) =>
    `<svg class="tool-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (a === "screenshot" || a === "computer") return svg(`<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/>`);
  if (/click|mouse|drag/.test(a)) return svg(`<path d="M4 4l7 16 2-6 6-2z"/>`);
  if (a === "type" || a === "key") return svg(`<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>`);
  if (a === "web_search") return svg(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`);
  if (a === "shell") return svg(`<path d="M4 17l6-5-6-5M12 19h8"/>`);
  if (a.includes("routine")) return svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`);
  if (a === "scroll") return svg(`<path d="M12 5v14M8 9l4-4 4 4M8 15l4 4 4-4"/>`);
  return svg(`<circle cx="12" cy="12" r="3"/>`);
}

function render(): void {
  ensureShell();
  applyDeskSize();
  const bot = currentBot();
  paintTitle(bot);
  paintRail(bot);
  paintChatPane(bot);
  paintLivePane(bot);
  paintModal();
  if (state.modal === "vault") bindVaultSearch();
  if (state.modal === "routine") {
    paintRoutineWhen();
    paintSchedPop();
  } else {
    state.schedPop = null;
    $("#sched-host")?.replaceChildren();
  }
  paintTeach(bot);
  paintCtxMenu();
  paintGrokAuth();
  paintAccountGate();
  paintHarnessBanner();
  paintCloudSoon();
  syncEditorChips(bot);
  try {
    refreshAvatars();
  } catch (err) {
    console.warn("avatars", err);
  }
}

function refreshAvatars(): void {
  const items = [...document.querySelectorAll<HTMLElement>("[data-avatar]")].flatMap((el) => {
    // The selector requires the attribute, so dataset.avatar is a string here
    // (possibly the empty one, which botById and both key tests already handle).
    const id = el.dataset.avatar as string;
    const bot = botById(id);
    if (!bot && id !== "create" && id !== "about") return [];
    const preview = el.dataset.preview === "1";
    const wake = state.railWake;
    const mood =
      id === "about"
        ? defaultAvatar({ expression: "happy", animation: "bounce", body: "rounder" })
        : id === "create"
          ? defaultAvatar({ expression: state.createFace, animation: "idle" })
          : wake && wake.id === id && (el.dataset.avatarSlot || "") === "rail" && Date.now() < wake.until
            ? wake.mood
            : inferMood(bot, { preview });
    const slot = el.dataset.avatarSlot || "default";
    const framing =
      el.dataset.avatarFraming || (slot === "editor" || slot === "create" || slot === "about" ? "body" : "icon");
    return [
      {
        el,
        id,
        slot,
        size: Number(el.dataset.avatarSize || 36),
        color: id === "about" ? "#ff2d95" : bot?.color || AVATAR_COLORS[0]!,
        framing,
        body: id === "about" ? "rounder" : defaultAvatar(bot?.avatar).body,
        mood,
      },
    ];
  });
  syncAvatars(items);
}

function applyDeskSize(): void {
  const frame = $("#shell-root");
  if (!frame) return;
  const size = state.teach || state.deskSize === "full" ? "full" : "side";
  const collapsed = !state.showComputer && !state.botEdit && size !== "full" && !state.teach;
  frame.classList.remove("desk-side", "desk-wide", "desk-full", "pane-collapsed");
  frame.classList.add("desk-" + size);
  if (collapsed) frame.classList.add("pane-collapsed");
  const chat = $("#chat");
  if (chat) {
    const hide = size === "full" && !state.botEdit;
    chat.hidden = hide;
    chat.style.display = hide ? "none" : "";
  }
  let fab = $<HTMLButtonElement>("#monitor-fab");
  if (!fab) {
    const main = $(".main");
    if (main) {
      fab = document.createElement("button");
      fab.className = "monitor-fab";
      fab.id = "monitor-fab";
      fab.dataset.act = "expand-pane";
      fab.title = "Show computer";
      fab.innerHTML = iconMonitor();
      main.appendChild(fab);
    }
  }
  if (fab) fab.hidden = true;
  applyPaneWidth();
  applyRailWidth();
  bindSplit();
  bindRailResize();
}

function applyPaneWidth(): void {
  const frame = $("#shell-root");
  if (!frame) return;
  const w = Math.round(state.paneWidth || 420);
  frame.style.setProperty("--pane-w", `${w}px`);
}

function applyRailWidth(): void {
  const w = Math.round(Math.min(248, Math.max(68, state.railWidth || 72)));
  document.documentElement.style.setProperty("--sidebar", `${w}px`);
}

function bindRailResize(): void {
  const rail = $("#rail");
  if (!rail) return;
  let handle = $("#rail-resize");
  if (!handle) {
    handle = document.createElement("div");
    handle.id = "rail-resize";
    handle.className = "rail-resize";
    handle.title = "Drag to resize sidebar";
    rail.appendChild(handle);
  }
  if (handle.dataset.ready) return;
  handle.dataset.ready = "1";
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rail.getBoundingClientRect().width;
    handle.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      state.railWidth = Math.min(248, Math.max(68, startW + (ev.clientX - startX)));
      applyRailWidth();
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem("railWidth", String(Math.round(state.railWidth)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function bindSplit(): void {
  const main = $(".main");
  if (!main) return;
  let split = $("#split");
  if (!split) {
    split = document.createElement("div");
    split.id = "split";
    split.className = "split";
    split.title = "Drag to resize";
    const pane = $("#live-pane");
    if (pane) main.insertBefore(split, pane);
    else main.appendChild(split);
  }
  if (split.dataset.ready) return;
  split.dataset.ready = "1";
  split.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const pane = $("#live-pane");
    if (!pane || pane.hidden) return;
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const mainW = main.getBoundingClientRect().width;
    split.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(Math.max(startW + (startX - ev.clientX), 280), Math.max(280, mainW - 280));
      state.paneWidth = next;
      applyPaneWidth();
    };
    const onUp = () => {
      split.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem("paneWidth", String(Math.round(state.paneWidth)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function deskSizeButton(): string {
  if (state.deskSize === "full") {
    return `<button class="pill" data-act="collapse-full" type="button" title="Compact">${iconCompact()} Compact</button>`;
  }
  return `<button class="pill" data-act="open-desk" type="button" title="Open">${iconExpand()} Open</button>`;
}

function resolvedHarness(bot: Bot | null | undefined): { provider: string; model: string } {
  const global = state.settings?.harness || {};
  const local = bot?.harness || {};
  const provider =
    local.provider && local.provider !== "default" ? local.provider : global.provider || "grok-build";
  let model = (local.model && String(local.model).trim()) || "";
  if (!model && global.provider === provider) model = String(global.model || "").trim();
  if (!model) {
    if (isCliHost(provider)) model = "default";
    else if (provider === "grok-build" || provider === "spacexai") model = "grok-4.6";
    else model = provider;
  }
  return { provider, model };
}

function titleName(bot: Bot | null | undefined): string {
  if (!bot) return "Sub8";
  if (isCloudPlace()) return bot.name;
  const team = teamOf(bot);
  if (team && teamBots(team).length >= 2) return team.name || bot.name;
  return bot.name;
}

function titleChip(bot: Bot | null | undefined): string {
  if (isCloudPlace()) return `Cloud · ${bot?.desk?.ram || "4 GB"}`;
  const { provider, model } = resolvedHarness(bot);
  return `${provider} · ${model}`;
}

function paintTitle(bot: Bot | null | undefined): void {
  // ensureShell() writes #titlebar and only ever replaces its contents.
  const bar = $("#titlebar")!;
  const collapsed = !state.showComputer && !state.botEdit && state.deskSize !== "full";
  const runningN = (state.computers || []).filter((c) => c.status === "running").length;
  const shown = titleName(bot);
  const stamp = `${bot?.id || ""}|${shown}|${state.botEdit ? "1" : "0"}|${state.deskSize}|${collapsed ? "1" : "0"}|c${runningN}|${state.account?.view || ""}|${state.account?.email || ""}`;
  const avatarEl = bar.querySelector<HTMLElement>("[data-avatar-slot=title]");
  if (
    bar.dataset.stamp === stamp &&
    bar.querySelector("[data-act=vault]") &&
    bar.querySelector("[data-act=computers]") &&
    bar.querySelector("[data-act=lol]") &&
    (!bot || !avatarEl || avatarEl.dataset.avatar === bot.id)
  ) {
    const name = bar.querySelector(".botname-btn .bot-label");
    if (name && bot) name.textContent = shown;
    const chip = bar.querySelector(".harness-chip");
    if (chip) chip.textContent = titleChip(bot);
    return;
  }
  bar.dataset.stamp = stamp;
  const collapseAct = state.deskSize === "full" ? "collapse-full" : "collapse-pane";
  bar.innerHTML = `
    <div class="botname">${
      bot
        ? `<button class="botname-btn" data-act="bot-settings" title="Bot settings">
            <span class="avatar sm" data-avatar="${bot.id}" data-avatar-slot="title" data-avatar-size="32" data-avatar-framing="body"></span>
            <span class="bot-label">${escapeHtml(titleName(bot))}</span>
          </button>`
        : "Sub8"
    }
      <span class="muted harness-chip">${escapeHtml(titleChip(bot))}</span>
    </div>
    <div class="spacer"></div>
    <div class="title-actions">
      ${
        cloudOn()
          ? `<button class="account-chip" data-act="account-settings" title="Account">${escapeHtml(accountLabel())}</button>`
          : ""
      }
      <button class="iconbtn computer-btn" data-act="computers" title="Computers">${iconComputer()}${
        runningN ? `<span class="computer-badge">${runningN}</span>` : ""
      }</button>
      <button class="iconbtn" data-act="vault" title="Password vault">${iconLock()}</button>
      ${
        !bot
          ? `<button class="iconbtn" data-act="settings" title="Settings">${iconGear()}</button>`
          : collapsed
            ? `<button class="iconbtn" data-act="expand-pane" title="Show computer">${iconMonitor()}</button>`
            : `<button class="iconbtn" data-act="bot-settings" title="Bot settings">${iconGear()}</button>
               <button class="iconbtn" data-act="${collapseAct}" title="Collapse">${iconChevrons()}</button>`
      }
      <button type="button" class="lol-chip" data-act="lol" title="freebots.lol">lol</button>
    </div>`;
}

function sidebarSections(): SidebarSection[] {
  return Array.isArray(state.settings?.sidebarSections) ? state.settings.sidebarSections : [];
}

function teamNameFor(id: string | undefined, members: Bot[] = []): string {
  const known = (state.teams || []).find((t) => t.id === id);
  if (known?.name) return known.name;
  const chief = members.find((b) => b.teamRole === "chief");
  const desc = String(chief?.description || "");
  const m = desc.match(/^Chief of (.+)$/i);
  // One capture group, so a match always carries m[1].
  if (m) return m[1]!;
  return chief?.name || members[0]?.name || "Team";
}

function teamFromBots(id: string | null | undefined): Team | null {
  if (!id) return null;
  const members = viewBots().filter((b) => b.teamId === id && !b.hidden);
  const known = (state.teams || []).find((t) => t.id === id);
  if (!members.length && !known) return null;
  const chief = members.find((b) => b.teamRole === "chief");
  return {
    ...(known || {}),
    id,
    name: teamNameFor(id, members),
    chiefId: known?.chiefId || chief?.id || members[0]?.id || null,
    memberIds: known?.memberIds?.length ? known.memberIds : members.map((b) => b.id),
  };
}

function teamOf(bot: Bot | null | undefined): Team | null | undefined {
  if (!bot?.teamId) return null;
  const cloudTeams = isCloudPlace() ? state.cloudDraft?.teams || [] : [];
  return cloudTeams.find((t) => t.id === bot.teamId) || (state.teams || []).find((t) => t.id === bot.teamId) || teamFromBots(bot.teamId);
}

function teamBots(team: Team | null | undefined): Bot[] {
  if (!team) return [];
  const ids = new Set(team.memberIds || []);
  const rows = viewBots().filter((b) => !b.hidden && (ids.has(b.id) || b.teamId === team.id));
  const order = team.memberIds || [];
  return rows.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (a.teamRole === "chief" && b.teamRole !== "chief") return -1;
    if (b.teamRole === "chief" && a.teamRole !== "chief") return 1;
    if (ia >= 0 && ib >= 0) return ia - ib;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function pullTeams(): Promise<void> {
  return api("/api/teams")
    .then((rows) => {
      state.teams = Array.isArray(rows) ? rows : [];
    })
    .catch(() => {
      state.teams = state.teams || [];
    });
}

function pullChannels(): Promise<void> {
  return api("/api/channels")
    .then((rows) => {
      state.channels = Array.isArray(rows) ? rows : [];
    })
    .catch(() => {
      state.channels = state.channels || [];
    });
}

function railLayout(): { pinned: Bot[]; pinnedTeams: RailTeam[]; groups: RailGroup[]; teamGroups: RailTeam[] } {
  const vis = viewBots().filter((b) => !b.hidden);
  if (isCloudPlace()) {
    const teams = state.cloudDraft?.teams || [];
    const teamed = new Set<string>();
    const teamGroups: RailTeam[] = [];
    for (const t of teams) {
      const bots = vis.filter((b) => b.teamId === t.id || (t.memberIds || []).includes(b.id));
      if (!bots.length) continue;
      bots.forEach((b) => teamed.add(b.id));
      teamGroups.push({ id: t.id, name: t.name, bots, section: "", pinned: false });
    }
    const rest = vis.filter((b) => !teamed.has(b.id));
    return {
      pinned: [],
      pinnedTeams: [],
      groups: [{ id: "", name: "", bots: rest, teams: teamGroups }],
      teamGroups,
    };
  }
  const teamed = new Set<string>();
  const byId = new Map<string, RailTeam>();
  const teams = state.teams || [];
  for (const t of teams) {
    byId.set(t.id, { id: t.id, name: t.name, bots: [] });
  }
  for (const b of vis) {
    if (!b.teamId) continue;
    if (!byId.has(b.teamId)) byId.set(b.teamId, { id: b.teamId, name: teamNameFor(b.teamId, vis.filter((x) => x.teamId === b.teamId)), bots: [] });
    // The line above guarantees the key is present.
    byId.get(b.teamId)!.bots.push(b);
  }
  const teamGroups = [...byId.values()]
    .filter((t) => t.bots.length >= 2)
    .map((t) => {
      const rec: Partial<Team> = teams.find((row) => row.id === t.id) || {};
      return { ...t, name: rec.name || t.name, section: rec.section || "", pinned: Boolean(rec.pinned) };
    });
  // A one-bot leftover team is not a group — those bots sit in the rail as themselves.
  for (const t of teamGroups) {
    for (const b of t.bots) teamed.add(b.id);
  }
  const pinned = vis.filter((b) => b.pinned && !teamed.has(b.id));
  const rest = vis.filter((b) => !b.pinned && !teamed.has(b.id));
  const sections = sidebarSections();
  const known = new Set(sections.map((s) => s.id));
  const groups = sections.map((s) => ({
    id: s.id,
    name: s.name,
    bots: rest.filter((b) => b.section === s.id),
    teams: teamGroups.filter((t) => !t.pinned && t.section === s.id),
  }));
  const loose = rest.filter((b) => !b.section || !known.has(b.section));
  const looseTeams = teamGroups.filter((t) => !t.pinned && (!t.section || !known.has(t.section)));
  groups.push({ id: "", name: groups.length ? "Unassigned" : "", bots: loose, teams: looseTeams });
  return { pinned, pinnedTeams: teamGroups.filter((t) => t.pinned), groups, teamGroups };
}

function ensureRailNode(b: Bot): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "rail-bot";
  node.dataset.id = b.id;
  node.draggable = true;
  node.innerHTML = `
    <button class="avatar" data-act="select" data-id="${b.id}">
      <span class="avatar-3d" data-avatar="${b.id}" data-avatar-slot="rail" data-avatar-size="56" data-avatar-framing="body"></span>
      <i class="rail-unread" hidden></i>
    </button>`;
  return node;
}

function ensureRailTeamNode(t: RailTeam): HTMLButtonElement {
  const cluster = document.createElement("button");
  cluster.type = "button";
  cluster.className = "rail-team";
  cluster.dataset.act = "select-team";
  cluster.dataset.id = t.id;
  cluster.draggable = true;
  cluster.innerHTML = `<span class="rail-team-grid"></span>`;
  return cluster;
}

function paintPlaceSwitch(): void {
  const host = $("#place-switch");
  if (!host) return;
  if (!cloudOn()) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const onCloud = isCloudPlace() || state.cloudSoonOpen;
  host.innerHTML = `
    <button type="button" class="place-btn ${onCloud ? "" : "on"}" data-act="place" data-id="local" title="Local">Local</button>
    <button type="button" class="place-btn ${onCloud ? "on" : ""}" data-act="place" data-id="cloud" title="Cloud">Cloud</button>`;
}

function paintTeamCluster(cluster: HTMLElement, t: RailTeam, bot: Bot | null | undefined): void {
  cluster.dataset.id = t.id;
  cluster.draggable = true;
  const on = t.bots.some((b) => b.id === bot?.id);
  cluster.classList.toggle("active", on);
  cluster.classList.toggle("busy", t.bots.some((b) => b.busy));
  cluster.title = `${t.name || "Team"} · drag to a section · right-click to rename`;
  const extra = Math.max(0, t.bots.length - 3);
  const shown = extra > 0 ? t.bots.slice(0, 3) : t.bots.slice(0, 4);
  const grid = cluster.querySelector(".rail-team-grid") || cluster;
  grid.innerHTML = `${shown
    .map(
      (b, i) =>
        `<span class="rail-team-face" data-avatar="${b.id}" data-avatar-slot="rail-team-${t.id}-${i}" data-avatar-size="28" data-avatar-framing="icon"></span>`,
    )
    .join("")}${extra > 0 ? `<span class="rail-team-more">+${extra}</span>` : ""}`;
}

function paintRail(bot: Bot | null | undefined): void {
  const rail = $("#rail");
  if (!rail) return;
  if (rail.dataset.ready !== "scroll") {
    rail.innerHTML = `
      <div class="place-switch" id="place-switch"></div>
      <button class="plus" data-act="create" title="${isCloudPlace() ? "Create Cloud Bot" : "Create new Bot"}">+</button>
      <div class="rail-bots" id="rail-bots"></div>
      <div class="channel-rail" id="channel-rail" hidden></div>
      <button class="me" data-act="profile" title="App settings"></button>
      <div class="rail-resize" id="rail-resize" title="Drag to resize sidebar"></div>`;
    rail.dataset.ready = "scroll";
    bindRailResize();
  }
  const plus = rail.querySelector<HTMLElement>(".plus[data-act=create]");
  if (plus) {
    plus.hidden = false;
    plus.title = isCloudPlace() ? "Create Cloud Bot" : "Create new Bot";
  }
  paintPlaceSwitch();
  // The block above writes #rail-bots on the first paint and never removes it.
  const host = $("#rail-bots")!;
  const { pinned, pinnedTeams, groups, teamGroups } = railLayout();
  const keep = new Set(viewBots().map((b) => b.id));
  const teamKeep = new Set((teamGroups || []).map((t) => t.id));
  const nodes = new Map<string, HTMLElement>();
  const teamNodes = new Map<string, HTMLElement>();
  for (const node of [...host.querySelectorAll<HTMLElement>(".rail-bot")]) {
    if (!keep.has(node.dataset.id as string) || botById(node.dataset.id)?.hidden) node.remove();
    else nodes.set(node.dataset.id as string, node);
  }
  for (const node of [...host.querySelectorAll<HTMLElement>(".rail-team")]) {
    if (!teamKeep.has(node.dataset.id as string)) node.remove();
    else teamNodes.set(node.dataset.id as string, node);
  }
  host.innerHTML = "";
  const addBot = (b: Bot) => {
    let node = nodes.get(b.id) || ensureRailNode(b);
    node.querySelector(".rail-edit")?.remove();
    node.draggable = true;
    // ensureRailNode() writes the .avatar button, and nothing removes it.
    const btn = node.querySelector<HTMLElement>(".avatar")!;
    btn.draggable = true;
    const on = b.id === bot?.id;
    const busy = Boolean(b.busy || b.vm?.status === "starting");
    node.classList.toggle("active", on);
    node.classList.toggle("busy", busy);
    btn.classList.toggle("active", on);
    btn.classList.toggle("busy", busy);
    btn.classList.toggle("pinned", Boolean(b.pinned));
    const unread = node.querySelector<HTMLElement>(".rail-unread");
    if (unread) unread.hidden = !b.unread;
    btn.title = b.name;
    host.appendChild(node);
  };
  const addTeam = (t: RailTeam) => {
    if (!t?.bots?.length) return;
    if (t.bots.length < 2) {
      for (const b of t.bots) addBot(b);
      return;
    }
    const cluster = teamNodes.get(t.id) || ensureRailTeamNode(t);
    paintTeamCluster(cluster, t, bot);
    host.appendChild(cluster);
  };
  if (pinned.length || pinnedTeams.length) {
    const pinnedMulti = pinnedTeams.filter((t) => t.bots.length >= 2);
    const pinnedSolo = [
      ...pinned,
      ...pinnedTeams.filter((t) => t.bots.length === 1).flatMap((t) => t.bots),
    ];
    if (pinnedMulti.length + pinnedSolo.length >= 2) host.appendChild(sectionTag("pinned", "Pinned"));
    for (const t of pinnedMulti) addTeam(t);
    for (const b of pinnedSolo) addBot(b);
  }
  for (const g of groups) {
    const multi = g.teams.filter((t) => t.bots.length >= 2);
    const bots = [
      ...g.bots,
      ...g.teams.filter((t) => t.bots.length === 1).flatMap((t) => t.bots),
    ];
    if (!multi.length && !bots.length) continue;
    // A named section keeps its label. "Unassigned" is only a group when it holds more than one thing.
    if (g.name && (g.id || multi.length + bots.length >= 2)) host.appendChild(sectionTag(g.id, g.name));
    for (const t of multi) addTeam(t);
    for (const b of bots) addBot(b);
  }
  bindRailHover(host);
  bindRailDnD(host);
  paintChannelRail();
}

function paintChannelRail(): void {
  const rail = $("#rail");
  if (!rail) return;
  let host = $("#channel-rail");
  if (!host) {
    host = document.createElement("div");
    host.id = "channel-rail";
    host.className = "channel-rail";
    const me = rail.querySelector<HTMLElement>(".me[data-act=profile]");
    rail.insertBefore(host, me || $("#rail-resize") || null);
  }
  const rows = Array.isArray(state.channels) ? state.channels : [];
  if (!rows.length) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = `<div class="channel-rail-label" title="Channel rooms — not desk teams">Rooms</div>${rows
    .map((ch) => {
      const members = Array.isArray(ch.memberIds) ? ch.memberIds : [];
      const names = members.map((id) => botById(id)?.name).filter(Boolean);
      const bits = [ch.name || "channel"];
      if (ch.description) bits.push(ch.description);
      bits.push(names.length ? names.join(", ") : `${members.length} members`);
      const on = state.selectedChannel === ch.id ? " on" : "";
      return `<button type="button" class="channel-rail-item${on}" data-act="select-channel" data-id="${escapeHtml(ch.id)}" title="${escapeHtml(bits.join(" · "))}"><span class="channel-rail-hash">#</span><span class="channel-rail-name">${escapeHtml(ch.name || "channel")}</span></button>`;
    })
    .join("")}`;
}

function isNamedSection(id: string | undefined): boolean {
  return Boolean(id && id !== "pinned");
}

function sectionTag(id: string | undefined, name: string): HTMLDivElement {
  const tag = document.createElement("div");
  tag.className = "rail-sec";
  tag.dataset.sec = id || "";
  tag.title = isNamedSection(id) ? `${name} · right-click to rename` : name;
  tag.innerHTML = `<span>${escapeHtml(name)}</span>`;
  if (isNamedSection(id)) tag.classList.add("editable");
  return tag;
}

function bindRailHover(host: HTMLElement): void {
  if (host.dataset.hover) return;
  host.dataset.hover = "1";
  host.addEventListener("pointerenter", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".rail-bot");
    if (!row || !host.contains(row)) return;
    const bot = botById(row.dataset.id);
    if (!bot) return;
    const mood = inferMood(bot);
    if (!isSleepingMood(mood)) return;
    state.railWake = { id: bot.id, mood: randomWakeMood(), until: Date.now() + 8_000 };
    refreshAvatars();
  }, true);
  host.addEventListener("pointerleave", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".rail-bot");
    if (!row || (e.relatedTarget as HTMLElement | null)?.closest?.(".rail-bot") === row) return;
    if (state.railWake?.id === row.dataset.id) {
      state.railWake!.until = Date.now() + 1_200;
      setTimeout(() => refreshAvatars(), 1_250);
    }
  }, true);
}

function bindRailDnD(host: HTMLElement): void {
  if (host.dataset.dnd) return;
  host.dataset.dnd = "1";
  // dragstart, dragover and drop always carry a dataTransfer; the DOM lib types
  // it nullable only because the DragEvent constructor lets you leave it out.
  host.addEventListener("dragstart", (e) => {
    const team = (e.target as HTMLElement).closest<HTMLElement>(".rail-team");
    if (team?.dataset.id) {
      e.dataTransfer!.setData("text/sub8-team-id", team.dataset.id);
      e.dataTransfer!.setData("text/plain", `team:${team.dataset.id}`);
      e.dataTransfer!.effectAllowed = "move";
      team.classList.add("dragging");
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".rail-bot");
    if (!row) return;
    e.dataTransfer!.setData("text/sub8bot-id", row.dataset.id as string);
    e.dataTransfer!.setData("text/plain", row.dataset.id as string);
    e.dataTransfer!.effectAllowed = "move";
    row.classList.add("dragging");
  });
  host.addEventListener("dragend", (e) => {
    (e.target as HTMLElement).closest<HTMLElement>(".rail-bot")?.classList.remove("dragging");
    (e.target as HTMLElement).closest<HTMLElement>(".rail-team")?.classList.remove("dragging");
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
  });
  host.addEventListener("dragover", (e) => {
    e.preventDefault();
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
    const sec = (e.target as HTMLElement).closest<HTMLElement>(".rail-sec");
    const team = (e.target as HTMLElement).closest<HTMLElement>(".rail-team");
    const bot = (e.target as HTMLElement).closest<HTMLElement>(".rail-bot");
    (sec || team || bot)?.classList.add("drag-over");
  });
  host.addEventListener("drop", (e) => {
    e.preventDefault();
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
    const dest = railDropTarget(e.target as HTMLElement);
    const teamId = railDragTeamId(e.dataTransfer!);
    if (teamId) {
      moveTeamTo(teamId, dest);
      return;
    }
    const id =
      e.dataTransfer!.getData("text/sub8bot-id") ||
      e.dataTransfer!.getData("text/octobot-id") ||
      e.dataTransfer!.getData("text/plain");
    if (!id || id.startsWith("team:")) return;
    moveBotTo(id, dest);
  });
}

function railDragTeamId(dt: DataTransfer): string {
  const typed = dt.getData("text/sub8-team-id");
  if (typed) return typed;
  const plain = String(dt.getData("text/plain") || "");
  return plain.startsWith("team:") ? plain.slice(5) : "";
}

function railDropTarget(el: HTMLElement): { section: string; pinned: boolean } {
  const secEl = el.closest?.<HTMLElement>(".rail-sec");
  const ontoTeam = el.closest?.<HTMLElement>(".rail-team");
  const onto = el.closest?.<HTMLElement>(".rail-bot");
  let section = "";
  let pinned = false;
  if (secEl) {
    const sid = secEl.dataset.sec || "";
    if (sid === "pinned") pinned = true;
    else section = sid;
  } else if (ontoTeam) {
    const rec: Partial<Team> = (state.teams || []).find((t) => t.id === ontoTeam.dataset.id) || {};
    if (rec.pinned) pinned = true;
    else section = rec.section || "";
  } else if (onto) {
    const other = state.bots.find((b) => b.id === onto.dataset.id);
    if (other?.pinned) pinned = true;
    else section = other?.section || "";
  }
  return { section, pinned };
}

function moveBotTo(id: string, { section = "", pinned = false }: { section?: string; pinned?: boolean } = {}): void {
  const b = state.bots.find((x) => x.id === id);
  if (!b) return;
  b.section = section;
  b.pinned = pinned;
  api(`/api/bots/${id}`, { method: "PATCH", body: { section, pinned } });
  render();
}

function upsertLocalTeam(saved: Team | null | undefined): void {
  if (!saved?.id) return;
  const rest = (state.teams || []).filter((x) => x.id !== saved.id);
  state.teams = [...rest, saved];
}

function moveTeamTo(id: string | undefined, { section = "", pinned = false }: { section?: string; pinned?: boolean } = {}): void {
  if (!id) return;
  const rec = (state.teams || []).find((x) => x.id === id);
  if (rec) {
    rec.section = section;
    rec.pinned = pinned;
  } else {
    const inferred = teamFromBots(id);
    if (inferred) {
      inferred.section = section;
      inferred.pinned = pinned;
      upsertLocalTeam(inferred);
    }
  }
  // api() answers `unknown`; upsertLocalTeam guards its own argument.
  api(`/api/teams/${id}`, { method: "PATCH", body: { section, pinned } }).then(upsertLocalTeam as (saved: unknown) => void);
  render();
}

function renameTeam(id: string | undefined, name: string | undefined): void {
  const next = String(name || "").trim();
  if (!id || !next) return;
  const rec = (state.teams || []).find((x) => x.id === id);
  if (rec) rec.name = next;
  api(`/api/teams/${id}`, { method: "PATCH", body: { name: next } }).then(upsertLocalTeam as (saved: unknown) => void);
}


function isCodeAgentKind(value: unknown): boolean {
  const k = String(value || "")
    .toLowerCase()
    .replaceAll("_", "-");
  return k === "code-agent" || k === "cloud-agent";
}

function codeAgentFromMsg(m: Message | null | undefined): CodeAgentSession | null {
  if (!m || typeof m !== "object") return null;
  if (m.codeAgent && typeof m.codeAgent === "object") return m.codeAgent;
  if (isCodeAgentKind(m.kind) || isCodeAgentKind(m.type)) {
    return m.session && typeof m.session === "object" ? m.session : m;
  }
  const bags = [m.attachments, m.widgets];
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue;
    for (const a of bag) {
      if (!a || typeof a !== "object") continue;
      if (a.codeAgent && typeof a.codeAgent === "object") return a.codeAgent;
      if (isCodeAgentKind(a.kind) || isCodeAgentKind(a.type) || isCodeAgentKind(a.name)) return a;
    }
  }
  return null;
}

function safeHttpUrl(value: unknown): string {
  const s = String(value || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

function renderCodeAgentCard(m: Message): string {
  const s = codeAgentFromMsg(m) || {};
  const status = String(s.status || "running").trim() || "running";
  const cwd = String(s.cwd || "").trim();
  const prUrl = safeHttpUrl(s.prUrl);
  const title = String(s.prompt || m.content || "Code agent").trim() || "Code agent";
  const statusClass = status.toLowerCase().replaceAll("_", "-").replace(/[^a-z0-9-]/g, "");
  return `<div class="code-agent-card" data-mid="${escapeHtml(m.id || "")}">
    <div class="code-agent-head">
      <span class="code-agent-status is-${escapeHtml(statusClass)}">${escapeHtml(status)}</span>
      <span class="code-agent-title">${escapeHtml(title.slice(0, 80))}</span>
    </div>
    ${cwd ? `<div class="code-agent-cwd" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</div>` : ""}
    ${prUrl ? `<a class="code-agent-pr" href="${escapeHtml(prUrl)}" target="_blank" rel="noopener">Open PR</a>` : ""}
  </div>`;
}

function renderChoiceCard(m: Message): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const closed = m.pending === false;
  const rows = (m.choices || [])
    .map((c, i) => {
      const letter = String(c.id || letters[i] || i + 1).slice(0, 1).toUpperCase();
      const on = m.selected?.id === c.id ? " on" : "";
      return `<button type="button" class="choice-row${on}" data-act="pick-choice" data-mid="${escapeHtml(m.id)}" data-cid="${escapeHtml(c.id)}" ${closed ? "disabled" : ""}>
        <span class="choice-letter">${escapeHtml(letter)}</span>
        <span>${escapeHtml(c.label)}</span>
      </button>`;
    })
    .join("");
  const custom =
    m.allowCustom !== false && !closed
      ? `<div class="choice-custom-row">
        <input class="choice-custom" data-mid="${escapeHtml(m.id)}" ${m.kind === "secret-request" ? 'type="password" autocomplete="off" ' : ""}placeholder="${m.kind === "secret-request" ? "Paste here — it stays out of chat" : "Type your own answer"}" />
        <button type="button" class="choice-send" data-act="send-choice" data-mid="${escapeHtml(m.id)}">Send</button>
      </div>`
      : closed && m.selected?.label && m.kind !== "secret-request"
        ? `<div class="choice-picked">You: ${escapeHtml(m.selected.label)}</div>`
        : closed && m.kind === "secret-request"
          ? // Tell the truth per place. Locally the answer POSTs to
            // /api/bots/:id/choice, which routes a secretPick to the vault or
            // mcpRemote.setServerAuth and never writes it to the thread. In the
            // Cloud place submitChoice sends `Picked: <the secret>` as an
            // ordinary chat message, so the old copy promised something false --
            // and a false assurance is worse than none, because it is exactly
            // what convinces someone to paste a production credential. Until the
            // Cloud path has a real destination for secrets (see resume.md), say
            // what actually happens.
            isCloudPlace()
            ? `<div class="choice-picked">Sent. Heads up: on Cloud this answer is part of the chat — rotate it if it was a real credential.</div>`
            : `<div class="choice-picked">Credential saved. It is not in this chat.</div>`
          : "";
  return `<div class="choice-card" data-mid="${escapeHtml(m.id || "")}">
    <div class="choice-head">
      <div>
        <div class="choice-title">${escapeHtml(m.content || "Pick one")}</div>
        ${m.hint ? `<div class="choice-hint">${escapeHtml(m.hint)}</div>` : ""}
      </div>
      ${closed ? "" : `<button type="button" class="choice-x" data-act="dismiss-choice" data-mid="${escapeHtml(m.id)}">×</button>`}
    </div>
    <div class="choice-list">${rows}</div>
    ${custom}
  </div>`;
}

function botBrief(bot: Bot, team: Team | null | undefined): BotBrief {
  const role = bot.teamRole === "chief" ? "Chief" : bot.teamRole === "worker" ? "Worker" : "";
  const raw = String(bot.description || "").trim();
  const generic = /^(Chief of |Worker on )/i.test(raw);
  const job =
    (!generic && raw) ||
    (bot.teamRole === "chief"
      ? "Leads this team. Assigns work on the shared desk and reports back."
      : bot.teamRole === "worker"
        ? "Does assigned work on the shared desk. Reports to the chief."
        : raw);
  const mission = String(bot.instructions || "")
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const routine = (bot.routines || []).find((r) => r && r.enabled !== false);
  const now = bot.busy ? "Working now" : routine?.name ? `Standing job: ${routine.name}` : "";
  return {
    who: role && bot.name.toLowerCase() !== role.toLowerCase() ? `${bot.name} · ${role}` : bot.name,
    role,
    job,
    mission: mission ? mission.slice(0, 180) : "",
    now,
    team: team?.name || "",
  };
}

function setTeamBriefHidden(teamId: string | undefined, hidden: boolean): void {
  if (!teamId) return;
  state.teamBriefHidden = { ...(state.teamBriefHidden || {}), [teamId]: Boolean(hidden) };
  try {
    localStorage.setItem("sub8.teamBriefHidden", JSON.stringify(state.teamBriefHidden));
  } catch {
    /* ignore */
  }
}

function paintJobBar(bot: Bot | null | undefined): void {
  const host = $("#job-progress");
  if (!host) return;
  const team = teamOf(bot);
  const job = team?.job;
  const steps = job?.steps || [];
  if (!job || !steps.length) {
    host.hidden = true;
    host.innerHTML = "";
    host.classList.remove("is-complete");
    return;
  }
  const done = steps.filter((s) => s.status === "done").length;
  const blocked = steps.filter((s) => s.status === "blocked").length;
  const looping = steps.filter((s) => s.status === "looping" || (s.loopCount || 0) >= 2).length;
  const resolved = done + blocked;
  const complete = resolved === steps.length;
  const pct = Math.round((resolved / steps.length) * 100);
  const bits = [`${done}/${steps.length}`];
  if (blocked) bits.push(`${blocked} blocked`);
  if (looping) bits.push(`${looping} looping`);
  host.hidden = false;
  host.classList.toggle("is-complete", complete);
  host.innerHTML = `
    <div class="job-progress-head">
      <span class="job-progress-title">${escapeHtml(job.title || "Job")}</span>
      <span class="job-progress-count">${bits.join(" · ")}</span>
      <button type="button" class="job-progress-x" data-act="dismiss-job" data-id="${escapeHtml(team.id)}" title="Dismiss">${complete ? "Close" : "×"}</button>
    </div>
    <div class="job-progress-track${looping ? " is-looping" : ""}"><i style="width:${pct}%"></i></div>
    <div class="job-progress-steps">
      ${steps
        .map((s) => {
          const who = viewBots().find((b) => b.id === s.botId) || state.bots.find((b) => b.id === s.botId);
          const st = s.status || "pending";
          const loop = st === "looping" || (s.loopCount || 0) >= 2;
          const label = escapeHtml(s.label || who?.name || "step");
          const extra = s.detail ? escapeHtml(String(s.detail).slice(0, 48)) : st;
          return `<button type="button" class="job-step is-${escapeHtml(st)}${loop ? " is-looping" : ""}" data-act="team-tab" data-id="${escapeHtml(s.botId || "")}" title="${escapeHtml(s.detail || st)}">
            <span class="job-step-dot"></span>
            <span class="job-step-name">${label}</span>
            <span class="job-step-meta">${loop ? `looping${s.loopCount ? ` ×${s.loopCount}` : ""}` : extra}</span>
          </button>`;
        })
        .join("")}
    </div>`;
}

function paintTeamBrief(bot: Bot | null | undefined): void {
  const host = $("#team-brief");
  if (!host) return;
  const team = teamOf(bot);
  const members = teamBots(team);
  if (!team || members.length < 2 || state.teamBriefHidden?.[team.id]) {
    host.hidden = true;
    if (!team || members.length < 2) host.innerHTML = "";
    return;
  }
  // team is non-null here, and teamOf() only answers that for a real bot.
  const brief = botBrief(bot!, team);
  host.hidden = false;
  host.innerHTML = `
    <div class="team-brief-copy">
      <div class="team-brief-who">${escapeHtml(brief.who)}${brief.team ? `<span class="muted"> on ${escapeHtml(brief.team)}</span>` : ""}</div>
      <div class="team-brief-job">${escapeHtml(brief.job)}</div>
      ${brief.mission ? `<div class="team-brief-mission">${escapeHtml(brief.mission)}</div>` : ""}
      ${brief.now ? `<div class="team-brief-now">${escapeHtml(brief.now)}</div>` : ""}
    </div>
    <button type="button" class="team-brief-x" data-act="hide-team-brief" title="Hide">×</button>`;
}

function paintTeamTabs(bot: Bot): void {
  const host = $("#team-tabs");
  if (!host) return;
  const team = teamOf(bot);
  const members = teamBots(team);
  if (!team || members.length < 2) {
    host.hidden = true;
    host.innerHTML = "";
    host.removeAttribute("style");
    host.closest(".chat-head")?.classList.remove("has-tabs");
    paintTeamBrief(bot);
    return;
  }
  host.hidden = false;
  host.closest(".chat-head")?.classList.add("has-tabs");
  host.innerHTML = members
    .map((b) => {
      const role = b.teamRole === "chief" ? "Chief" : b.teamRole === "worker" ? "Worker" : "";
      const title = role && b.name.toLowerCase() !== role.toLowerCase() ? `${b.name} · ${role}` : b.name;
      return `<button type="button" class="chrome-tab ${b.id === bot.id ? "on" : ""} ${b.busy ? "busy" : ""}" data-act="team-tab" data-id="${b.id}" title="${escapeHtml(title)}">
        <span class="chrome-tab-ico" data-avatar="${b.id}" data-avatar-slot="tab" data-avatar-size="22" data-avatar-framing="body"></span>
        <span class="chrome-tab-title">${escapeHtml(b.name)}</span>
      </button>`;
    })
    .join("");
  paintTeamBrief(bot);
}

function paintChatPane(bot: Bot | null): void {
  // ensureShell() writes #chat and only ever replaces its contents.
  const chat = $("#chat")!;
  if (!bot) {
    chat.innerHTML = isCloudPlace()
      ? `<div class="empty cloud-empty">
          <strong>Cloud</strong>
          <p>${viewComputers().length ? "The desk is on the right. The bot for that desk should appear in the rail — click it to chat." : "No Cloud desk yet. New Cloud computer creates a DigitalOcean droplet."}</p>
          <button type="button" class="pill primary" data-act="cloud-new-computer">New Cloud computer</button>
        </div>`
      : `<div class="empty">Create a Bot to get started.</div>`;
    return;
  }
  const uiKey = teamOf(bot) ? "chrome-tabs-5" : isCloudPlace() ? "cloud-chrome-1" : "chrome-tabs-5";
  const typingHere = isFieldEl(document.activeElement) && chat.contains(document.activeElement);
  if (!typingHere && (chat.dataset.ui !== uiKey || !$("#thread") || !$<HTMLTextAreaElement>("#send textarea[name=q]") || !$(".composer-mic") || !$(".chat-head") || !$("#composer-mentions") || !$("#team-brief") || !$("#job-progress") || !$<HTMLButtonElement>("#chat [data-act=stop-turn]") || !$("#desk-wait"))) {
    chat.dataset.ui = uiKey;
    chat.innerHTML = `
      <div class="chat-head">
        <div class="chat-head-row">
          <span class="chat-head-name">${escapeHtml(bot.name)}</span>
        </div>
        <div class="chrome-tabs" id="team-tabs" hidden></div>
        <div class="team-brief" id="team-brief" hidden></div>
      </div>
      <div class="thread" id="thread"></div>
      <div class="composer">
        <div class="job-progress" id="job-progress" hidden></div>
        <div class="composer-mentions" id="composer-mentions"></div>
        <p class="composer-wait" id="desk-wait" hidden></p>
        <form class="input" id="send">
          <button type="button" class="composer-plus" data-act="plus-menu" title="Add">${iconPlus()}</button>
          <textarea name="q" rows="1" placeholder="Message ${escapeHtml(bot.name)}"></textarea>
          <button type="button" class="composer-send composer-stop" data-act="stop-turn" hidden title="Stop">${iconStop()}</button>
          <button type="button" class="composer-mic" data-act="dictate" title="Speak">${iconMic()}</button>
          <button type="submit" class="composer-send composer-go" title="Send">${iconSend()}</button>
        </form>
        <div class="composer-hint">Enter to send · Shift+Enter for a new line</div>
        <input id="attach-file" type="file" multiple hidden />
      </div>
      <div id="picker-host"></div>`;
    // The innerHTML above always writes the #send form.
    $<SendForm>("#send")!.addEventListener("submit", onSend);
    $<HTMLInputElement>("#attach-file")?.addEventListener("change", onAttachFiles);
    const box = $<SendForm>("#send")?.q;
    if (box) {
      box.addEventListener("keydown", onComposerKey);
      box.addEventListener("input", sizeComposer);
    }
    const thread = $("#thread");
    if (thread && !thread.dataset.followBound) {
      thread.dataset.followBound = "1";
      thread.addEventListener(
        "scroll",
        () => {
          const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
          state.chatFollow = gap < 80;
        },
        { passive: true },
      );
    }
    sizeComposer();
  } else {
    const input = $<SendForm>("#send")?.q;
    const team = teamOf(bot);
    const mates = teamBots(team).filter((b) => b.id !== bot.id);
    if (input) {
      input.placeholder = mates.length
        ? `Message ${bot.name} · @name to ping a teammate`
        : `Message ${bot.name}`;
    }
    const hn = $(".chat-head-name");
    if (hn) hn.textContent = bot.name;
    const hint = $(".composer-hint");
    if (hint) {
      hint.textContent = bot.busy
        ? "In line — extra messages wait until this job finishes"
        : mates.length
          ? "Enter to send · @Name talks to that Bot · Shift+Enter for a new line"
          : "Enter to send · Shift+Enter for a new line";
    }
    const go = $<HTMLButtonElement>(".composer-go");
    const halt = $<HTMLButtonElement>(".composer [data-act=stop-turn]");
    if (go) go.hidden = false;
    if (halt) halt.hidden = !bot.busy;
  }
  applyCloudComposerGate(bot);
  paintTeamTabs(bot);
  paintJobBar(bot);
  paintChat(bot);
  const mentions = $("#composer-mentions");
  if (mentions) {
    const team = teamOf(bot);
    const mates = teamBots(team);
    mentions.innerHTML = mates.length >= 2 ? mentionChipsHtml(team) : "";
    mentions.hidden = mates.length < 2;
  }
  const ph = $("#picker-host");
  if (ph) {
    const bits = [];
    if (state.attachments.length) bits.push(attachChipsHtml());
    if (state.plusMenu) bits.push(plusMenuHtml());
    ph.innerHTML = bits.join("");
  }
}

function mentionChipsHtml(team: Team | null | undefined): string {
  const members = teamBots(team);
  if (!members.length) return "";
  return `<div class="mention-chips">${members
    .map((b) => `<button type="button" class="mention-chip" data-act="mention" data-name="${escapeHtml(b.name)}">@${escapeHtml(b.name)}</button>`)
    .join("")}</div>`;
}

function plusMenuHtml(): string {
  return `<div class="plus-menu">
    <button type="button" data-act="attach-files">${iconClip()} Attach files</button>
    <button type="button" data-act="teach-task">${iconRecord()} Teach a task</button>
  </div>`;
}

function attachChipsHtml(): string {
  return `<div class="attach-chips">${state.attachments
    .map(
      (a, i) =>
        `<span class="attach-chip">${escapeHtml(a.name)}<button type="button" data-act="drop-attach" data-i="${i}">×</button></span>`,
    )
    .join("")}</div>`;
}

function paintTeach(bot: Bot | null | undefined): void {
  let host = $("#teach-host");
  if (!host) {
    const frame = $("#shell-root");
    if (!frame) return;
    host = document.createElement("div");
    host.id = "teach-host";
    frame.appendChild(host);
  }
  if (!state.teach || !bot) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const rec = state.teach === "recording";
  host.innerHTML = `
    <div class="teach-banner">
      <p>${
        rec
          ? `Recording… Do the task on ${escapeHtml(bot.name)}’s computer.`
          : `Record yourself doing a task. ${escapeHtml(bot.name)} learns the steps and can run them again on its own.`
      }</p>
      <button type="button" class="teach-rec ${rec ? "on" : ""}" data-act="${rec ? "stop-teach" : "start-teach"}">
        ${iconRecord()} ${rec ? "Stop recording" : "Start recording"}
      </button>
      <button type="button" class="teach-x" data-act="close-teach" title="Close">×</button>
    </div>
    <p class="teach-foot">You are driving ${escapeHtml(bot.name)}’s computer.</p>`;
}

function ctxIcon(kind: string): string {
  const svg = (d: string) =>
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (kind === "pin") return svg(`<path d="M12 17v5M8 3h8l-1 7h3l-6 7-6-7h3z"/>`);
  if (kind === "folder") return svg(`<path d="M3 7h6l2 2h10v10H3z"/>`);
  if (kind === "unread") return svg(`<path d="M18 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0z"/><path d="M12 14v7"/>`);
  if (kind === "info") return svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/>`);
  if (kind === "gear") return svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7 1 1.2 1.7 1.3H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1.7z"/>`);
  if (kind === "edit") return svg(`<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`);
  if (kind === "dup") return svg(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>`);
  if (kind === "copy") return svg(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>`);
  if (kind === "hide") return svg(`<path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.1A10 10 0 0 1 21 12c-1 1.8-2.4 3.3-4.1 4.4M6.1 6.1C4.4 7.2 3 8.7 2 12c1.6 2.8 4.4 5 8 6.1"/>`);
  if (kind === "del") return svg(`<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>`);
  if (kind === "plus") return svg(`<path d="M12 5v14M5 12h14"/><path d="M4 7h6l2 2"/>`);
  return "";
}

function paintCtxMenu(): void {
  let host = $("#ctx-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "ctx-host";
    document.body.appendChild(host);
  }
  const ctx = state.ctx;
  if (!ctx) {
    host.innerHTML = "";
    host.dataset.stamp = "";
    return;
  }
  const stamp = [
    ctx.type,
    ctx.teamId || "",
    ctx.botId || "",
    ctx.secId || "",
    ctx.naming ? "1" : "0",
    ctx.sub || "",
    ctx.x,
    ctx.y,
    ctx.mid || "",
  ].join("|");
  if (host.dataset.stamp === stamp && host.querySelector(".ctx-menu, .ctx-prompt, .ctx-sub")) return;
  host.dataset.stamp = stamp;
  if (ctx.type === "section") {
    const sec = sidebarSections().find((s) => s.id === ctx.secId);
    if (!sec) {
      host.innerHTML = "";
      return;
    }
    const left = Math.min(ctx.x, window.innerWidth - 240);
    const top = Math.min(ctx.y, window.innerHeight - 180);
    if (ctx.naming) {
      host.innerHTML = `<div class="ctx-prompt" style="top:${top}px;left:${left}px">
        <input id="ctx-sec-name" class="field" value="${escapeHtml(sec.name)}" placeholder="Section name" />
        <button type="button" class="pill primary" data-act="ctx-rename-section" data-sec="${escapeHtml(sec.id)}">Save</button>
      </div>`;
      setTimeout(() => {
        const input = $<HTMLInputElement>("#ctx-sec-name");
        if (!input) return;
        input.focus();
        input.select();
      }, 20);
      return;
    }
    host.innerHTML = `<div class="ctx-menu" style="top:${top}px;left:${left}px">
      <button type="button" class="ctx-item" data-act="ctx-rename-section-open" data-sec="${escapeHtml(sec.id)}">${ctxIcon("edit")}<span>Rename section</span></button>
      <button type="button" class="ctx-item ctx-danger" data-act="ctx-delete-section" data-sec="${escapeHtml(sec.id)}">${ctxIcon("del")}<span>Delete section</span></button>
    </div>`;
    return;
  }
  if (ctx.type === "team") {
    const rows = isCloudPlace() ? state.cloudDraft?.teams || [] : state.teams || [];
    const team = rows.find((t) => t.id === ctx.teamId) || teamFromBots(ctx.teamId);
    if (!team) {
      host.innerHTML = "";
      return;
    }
    const sections = sidebarSections();
    const left = Math.min(ctx.x, window.innerWidth - 240);
    const top = Math.min(ctx.y, window.innerHeight - 260);
    const item = (act: string, icon: string, label: string, extra = "") =>
      `<button type="button" class="ctx-item ${extra}" data-act="${act}" data-id="${team.id}">${ctxIcon(icon)}<span>${label}</span></button>`;
    if (ctx.naming && ctx.sub !== "move") {
      host.innerHTML = `<div class="ctx-prompt" style="top:${top}px;left:${left}px">
        <input id="ctx-team-name" class="field" value="${escapeHtml(team.name || "")}" placeholder="Group name" />
        <button type="button" class="pill primary" data-act="ctx-rename-team" data-id="${team.id}">Save</button>
      </div>`;
      setTimeout(() => {
        const input = $<HTMLInputElement>("#ctx-team-name");
        if (!input) return;
        input.focus();
        input.select();
      }, 20);
      return;
    }
    let move = "";
    if (ctx.sub === "move") {
      move = `<div class="ctx-sub" style="top:${top}px;left:${left + 228}px">
        <button type="button" class="ctx-item" data-act="ctx-new-section" data-id="${team.id}">${ctxIcon("plus")}<span>New section</span></button>
        <div class="ctx-sep"></div>
        <button type="button" class="ctx-item ${!team.section ? "on" : ""}" data-act="ctx-move" data-id="${team.id}" data-kind="team" data-sec="">${ctxIcon("folder")}<span>Unassigned</span></button>
        ${sections
          .map(
            (s) =>
              `<button type="button" class="ctx-item ${team.section === s.id ? "on" : ""}" data-act="ctx-move" data-id="${team.id}" data-kind="team" data-sec="${escapeHtml(s.id)}">${ctxIcon("folder")}<span>${escapeHtml(s.name)}</span></button>`,
          )
          .join("")}
      </div>`;
    }
    let namePrompt = "";
    if (ctx.naming && ctx.sub === "move") {
      namePrompt = `<div class="ctx-prompt" style="top:${top}px;left:${left + 228}px">
        <input id="ctx-sec-name" class="field" placeholder="Section name" />
        <button type="button" class="pill primary" data-act="ctx-create-section" data-id="${team.id}" data-kind="team">Create</button>
      </div>`;
    }
    host.innerHTML = `
      <div class="ctx-menu" style="top:${top}px;left:${left}px">
        ${item("ctx-rename-team-open", "edit", "Rename")}
        ${item("ctx-pin", "pin", team.pinned ? "Unpin" : "Pin")}
        <button type="button" class="ctx-item has-sub" data-act="ctx-move-open" data-id="${team.id}">${ctxIcon("folder")}<span>Move to</span><span class="ctx-caret">›</span></button>
      </div>
      ${move}
      ${namePrompt}`;
    if (ctx.naming) setTimeout(() => $<HTMLInputElement>("#ctx-sec-name")?.focus(), 20);
    return;
  }
  if (ctx.type === "tab") {
    const bot = botById(ctx.botId) || state.bots.find((b) => b.id === ctx.botId);
    if (!bot) {
      host.innerHTML = "";
      return;
    }
    const team = teamOf(bot);
    const left = Math.min(ctx.x, window.innerWidth - 240);
    const top = Math.min(ctx.y, window.innerHeight - 220);
    const item = (act: string, icon: string, label: string, extra = "") =>
      `<button type="button" class="ctx-item ${extra}" data-act="${act}" data-id="${bot.id}">${ctxIcon(icon)}<span>${label}</span></button>`;
    const briefOn = team && !state.teamBriefHidden?.[team.id];
    if (ctx.naming) {
      host.innerHTML = `<div class="ctx-prompt" style="top:${top}px;left:${left}px">
        <input id="ctx-tab-name" class="field" value="${escapeHtml(bot.name)}" placeholder="Tab name" />
        <button type="button" class="pill primary" data-act="ctx-rename-tab" data-id="${bot.id}">Save</button>
      </div>`;
      setTimeout(() => {
        const input = $<HTMLInputElement>("#ctx-tab-name");
        if (!input) return;
        input.focus();
        input.select();
      }, 20);
      return;
    }
    host.innerHTML = `<div class="ctx-menu" style="top:${top}px;left:${left}px">
      ${item("ctx-rename-tab-open", "edit", "Rename")}
      ${item(briefOn ? "hide-team-brief" : "show-team-brief", "info", briefOn ? "Hide description" : "Show description")}
      ${item("ctx-edit", "gear", "Open settings")}
      <div class="ctx-sep"></div>
      ${item("ctx-tab-remove", "del", "Remove from team", "ctx-danger")}
    </div>`;
    return;
  }
  if (ctx.type === "message") {
    const left = Math.min(ctx.x, window.innerWidth - 220);
    const top = Math.min(ctx.y, window.innerHeight - 80);
    host.innerHTML = `<div class="ctx-menu" style="top:${top}px;left:${left}px">
      <button type="button" class="ctx-item ctx-danger" data-act="ctx-del-msg">${ctxIcon("del")}<span>Delete message</span></button>
    </div>`;
    return;
  }
  const bot = botById(ctx.botId) || state.bots.find((b) => b.id === ctx.botId);
  if (!bot) {
    host.innerHTML = "";
    return;
  }
  const sections = sidebarSections();
  const left = Math.min(ctx.x, window.innerWidth - 240);
  const top = Math.min(ctx.y, window.innerHeight - 340);
  const item = (act: string, icon: string, label: string, extra = "") =>
    `<button type="button" class="ctx-item ${extra}" data-act="${act}" data-id="${bot.id}">${ctxIcon(icon)}<span>${label}</span></button>`;
  if (isLiveCloud()) {
    host.innerHTML = `
    <div class="ctx-menu" style="top:${top}px;left:${left}px">
      ${item("ctx-edit", "edit", "Edit")}
      <div class="ctx-sep"></div>
      ${item("ctx-del", "del", isCloudChief(bot) ? "Delete Cloud computer" : "Delete", "ctx-danger")}
    </div>`;
    return;
  }
  let move = "";
  if (ctx.sub === "move") {
    move = `<div class="ctx-sub" style="top:${top}px;left:${left + 228}px">
      <button type="button" class="ctx-item" data-act="ctx-new-section" data-id="${bot.id}">${ctxIcon("plus")}<span>New section</span></button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item ${!bot.section ? "on" : ""}" data-act="ctx-move" data-id="${bot.id}" data-sec="">${ctxIcon("folder")}<span>Unassigned</span></button>
      ${sections
        .map(
          (s) =>
            `<button type="button" class="ctx-item ${bot.section === s.id ? "on" : ""}" data-act="ctx-move" data-id="${bot.id}" data-sec="${escapeHtml(s.id)}">${ctxIcon("folder")}<span>${escapeHtml(s.name)}</span></button>`,
        )
        .join("")}
    </div>`;
  }
  let namePrompt = "";
  if (ctx.naming) {
    namePrompt = `<div class="ctx-prompt" style="top:${top}px;left:${left + 228}px">
      <input id="ctx-sec-name" class="field" placeholder="Section name" />
      <button type="button" class="pill primary" data-act="ctx-create-section" data-id="${bot.id}">Create</button>
    </div>`;
  }
  host.innerHTML = `
    <div class="ctx-menu" style="top:${top}px;left:${left}px">
      ${item("ctx-pin", "pin", bot.pinned ? "Unpin" : "Pin")}
      <button type="button" class="ctx-item has-sub" data-act="ctx-move-open" data-id="${bot.id}">${ctxIcon("folder")}<span>Move to</span><span class="ctx-caret">›</span></button>
      ${item("ctx-unread", "unread", bot.unread ? "Mark as Read" : "Mark as Unread")}
      <div class="ctx-sep"></div>
      ${item("ctx-edit", "edit", "Edit Profile")}
      ${item("ctx-dup", "dup", "Duplicate")}
      <div class="ctx-sep"></div>
      ${item("ctx-copy", "copy", "Copy conversation ID")}
      ${item("ctx-hide", "hide", bot.hidden ? "Show in sidebar" : "Hide from sidebar")}
      <div class="ctx-sep"></div>
      ${item("ctx-del", "del", "Delete", "ctx-danger")}
    </div>
    ${move}
    ${namePrompt}`;
  if (ctx.naming) setTimeout(() => $<HTMLInputElement>("#ctx-sec-name")?.focus(), 20);
}


function paintLivePane(bot: Bot | null): void {
  if (isCloudPlace()) bot = currentBot();
  const pane = $("#live-pane");
  if (!pane) return;
  if (
    !$("#pane-head") ||
    !$("#computer-stack") ||
    !$("#bot-editor") ||
    document.querySelector('[data-act="desk-full"], [data-act="reconnect"], [data-act="resume-vm"], .desk-tools')
  ) {
    liveFrameKey = null;
    pane.innerHTML = `
    <div class="pane-head" id="pane-head"></div>
    <div id="computer-stack">
      <div class="screen-wrap" id="screen-wrap"></div>
      <div class="desk-actions">
        <button class="pill" data-act="refresh-stream" type="button">Refresh stream</button>
        <button class="pill" data-act="reboot-vm" type="button">Reboot</button>
        ${deskSizeButton()}
      </div>
      <div class="screen-label" id="screen-label"></div>
      <div class="section-h" id="routine-head">Routines <button class="iconbtn add-routine" data-act="add-routine" type="button" title="Add routine">+</button></div>
      <div id="routine-list"></div>
      <p class="error" id="vm-error"></p>
    </div>
    <div id="bot-editor" class="bot-editor" hidden></div>`;
  }
  {
    let row = $(".desk-actions");
    if (!row && $("#screen-wrap")) {
      row = document.createElement("div");
      row.className = "desk-actions";
      // The if() above has just found it.
      $("#screen-wrap")!.after(row);
    }
    if (row) {
      row.innerHTML = `<button class="pill" data-act="refresh-stream" type="button">Refresh stream</button>
        <button class="pill" data-act="reboot-vm" type="button">Reboot</button>
        ${deskSizeButton()}`;
    }
  }
  paintPaneHead(bot);
  const computer = $("#computer-stack");
  const editor = $("#bot-editor");
  pane.hidden = (!bot && !isCloudPlace()) || (!state.showComputer && !state.botEdit && state.deskSize !== "full");
  if (computer) computer.hidden = !state.showComputer || state.botEdit;
  if (editor) {
    editor.hidden = !state.botEdit;
    if (state.botEdit && bot) paintBotEditor(bot);
  }
  const label = $("#screen-label");
  if (label && bot) {
    const team = isCloudPlace() ? null : teamOf(bot);
    label.textContent = isCloudPlace()
      ? `${bot.name}'s screen`
      : bot.vm?.status === "starting" && bot.vm.hint
        ? bot.vm.hint
        : team
          ? `${team.name} desk · ${bot.name}`
          : `${bot.name}'s screen`;
  }
  const err = $("#vm-error");
  if (err) {
    // hard is only truthy when bot.vm.status is "error" and bot.vm.error is a
    // non-empty string, so both the desk and the message are on hand.
    const hard = bot?.vm?.status === "error" && bot.vm.error && !isTransientVmError(bot.vm.error);
    err.textContent = hard ? bot!.vm!.error! : "";
  }
  const routineHead =
    $("#routine-head") ||
    [...(computer?.querySelectorAll<HTMLElement>(".section-h") || [])].find((el) => /Routines/.test(el.textContent || ""));
  const routineList = $("#routine-list");
  // Cloud desks own routines too (Worker KV, fired by cron). Hiding the panel
  // there left bot-created routines invisible and unstoppable from this app.
  if (routineHead) routineHead.hidden = false;
  if (routineList) routineList.hidden = false;
  if (bot) paintRoutineList(bot);
  if (bot || isCloudPlace()) attachLiveFrame(bot);
}

function paintPaneHead(bot: Bot | null | undefined): void {
  const head = $("#pane-head");
  if (!head || !bot) return;
  const mode = state.deskSize === "full" ? "full" : state.botEdit ? "settings" : "desk";
  if (head.dataset.mode === mode) return;
  head.dataset.mode = mode;
  head.classList.toggle("is-settings", mode === "settings");
  if (mode === "settings") {
    head.hidden = false;
    head.innerHTML = `
      <button class="iconbtn" data-act="bot-settings" title="Back">${iconBack()}</button>
      <h2>Settings</h2>
      <span class="grow"></span>`;
  } else {
    head.hidden = true;
    head.innerHTML = "";
  }
}

function paintBotEditor(bot: Bot): void {
  const host = $("#bot-editor");
  if (!host) return;
  const active = document.activeElement;
  // host.contains(null) is false, so activeElement is an element by here.
  if (host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active!.tagName) && host.dataset.bot === bot.id) {
    return;
  }
  host.dataset.bot = bot.id;
  const colors = AVATAR_COLORS;
  const color = bot.color || AVATAR_COLORS[0]!;
  const avatar = defaultAvatar(bot.avatar);
  host.innerHTML = `
    <div class="avatar-studio">
      <div class="avatar-preview" data-avatar="${bot.id}" data-avatar-slot="editor" data-avatar-size="168" data-avatar-framing="body" data-preview="1"></div>
    </div>
    <label class="muted">Name</label>
    <input class="field" id="bn" value="${escapeHtml(bot.name || "")}" placeholder="Bot name" />
    <label class="muted">Title</label>
    <input class="field" id="bt" value="${escapeHtml(bot.title || "")}" placeholder="Describe what your Bot does" />
    <label class="muted">Description</label>
    <textarea class="field" id="bd" placeholder="What this Bot is for">${escapeHtml(bot.description || "")}</textarea>
    <div class="card row notify-card">
      <div>
        <div class="lbl">Notifications</div>
        <div class="sub">Get notified when this Bot finishes or needs input</div>
      </div>
      <button class="toggle ${bot.notificationsEnabled ? "on" : ""}" data-act="bot-notify"><i></i></button>
    </div>
    <label class="muted">Body</label>
    <div class="chips chips-scroll" id="body-chips">
      ${bodyList()
        .map(
          (b) =>
            `<button type="button" class="chip ${b.id === avatar.body ? "on" : ""}" data-act="avatar-body" data-id="${b.id}">${escapeHtml(b.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Face</label>
    <div class="chips chips-scroll" id="face-chips">
      ${faceList()
        .map(
          (f) =>
            `<button type="button" class="chip ${f.id === avatar.expression ? "on" : ""}" data-act="avatar-face" data-id="${f.id}">${escapeHtml(f.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Motion</label>
    <div class="chips chips-scroll" id="anim-chips">
      ${animList()
        .map(
          (a) =>
            `<button type="button" class="chip ${a.id === avatar.animation ? "on" : ""}" data-act="avatar-anim" data-id="${a.id}">${escapeHtml(a.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Instructions</label>
    <textarea class="field" id="bi" placeholder="Standing rules this Bot always follows">${escapeHtml(bot.instructions || "")}</textarea>
    ${(() => {
      const cloudEdit = isCloudPlace();
      const identity = resolveBotIdentity(bot);
      const harness = harnessFromIdentity(identity, bot);
      if (cloudEdit) {
        return `
    <label class="muted">Identity</label>
    <select class="field" id="bid">
      ${identityOptions(identity?.id || bot.identityId, bot.harness?.provider, bot)}
    </select>
    <label class="muted">Harness</label>
    <div class="field field-static">${escapeHtml(`${harnessDisplayName(harness.provider)} · ${harness.model}`)}</div>
    <input type="hidden" id="bh" value="${escapeHtml(harness.provider)}" />
    <input type="hidden" id="bm" value="${escapeHtml(harness.model)}" />`;
      }
      return `
    <label class="muted">Identity</label>
    <select class="field" id="bid">
      ${identityOptions(bot.identityId, bot.harness?.provider, bot)}
    </select>
    <label class="muted">Harness</label>
    <select class="field" id="bh">
      ${harnessProviderOptions(bot.harness?.provider || "default")}
    </select>
    <label class="muted">Model</label>
    ${modelPickerHtml(bot.harness?.provider || "default", bot.harness?.model || "", { id: "bm" })}`;
    })()}
    <label class="muted">Color</label>
    <div class="muted" style="margin:0 0 6px">Light colors use dark eyes and mouth.</div>
    <div class="swatches">
      ${colors
        .map(
          (c) =>
            `<button type="button" class="swatch ${c.toLowerCase() === color.toLowerCase() ? "on" : ""}" data-act="bot-color" data-color="${c}" style="background:${c}"></button>`
        )
        .join("")}
      <label class="swatch swatch-custom ${colors.some((c) => c.toLowerCase() === color.toLowerCase()) ? "" : "on"}" title="Custom color">
        <input type="color" id="bot-color-pick" value="${escapeHtml(color)}" />
      </label>
    </div>
    <button class="pill" style="margin-top:16px" data-act="advanced">Advanced</button>
    <button class="pill" style="margin-top:16px" data-act="save-bot">Save</button>
    <button class="danger" style="margin-top:10px" data-act="delete-bot" data-id="${bot.id}">${
      isLiveCloud()
        ? isCloudChief(bot)
          ? "Delete Cloud computer"
          : "Delete teammate"
        : state.confirmDeleteId === bot.id
          ? "Click again to delete"
          : "Delete Bot"
    }</button>`;
}

function paintRoutineList(bot: Bot | null | undefined): void {
  const rl = $("#routine-list");
  if (!rl || !bot) return;
  const cloud = isCloudPlace();
  // The cache holds one desk. Switching desks (or the first paint) fetches the
  // new one and repaints, rather than leaving the panel stuck on stale rows.
  if (cloud && cloudDeskIdOf(bot) && state.cloudRoutines?.computerId !== cloudDeskIdOf(bot)) {
    loadCloudRoutines(bot).then(() => paintRoutineList(bot));
  }
  const rows = cloud ? cloudRoutineRows(bot) : bot.routines || [];
  if (!rows.length) {
    const copy = cloud
      ? "Nothing scheduled on this desk. Press + to add a standing job."
      : "Chat does not create one. Press + to add a standing job.";
    rl.innerHTML = `<div class="routine-row"><span class="routine-clock">${iconClock()}</span><div><b>No routines yet</b><div class="muted">${copy}</div></div></div>`;
    return;
  }
  rl.innerHTML = rows
    .map((r) => {
      const on = r.enabled !== false;
      // One Cloud desk runs several bots off a single routine list, so name the
      // bot each row belongs to. Local routines are always the selected bot's.
      const owner = cloud ? viewBots().find((b) => b.id === r.botId) : null;
      const who = owner && owner.id !== bot.id ? ` · ${escapeHtml(owner.name || "bot")}` : "";
      return `<div class="routine-card ${on ? "" : "off"}">
        <div class="routine-top">
          <span class="routine-clock">${iconClock()}</span>
          <div class="routine-copy">
            <b>${escapeHtml(r.name || "Routine")}</b>
            <div class="muted">${escapeHtml(routineCadence(r))}${on ? "" : ", paused"}${r.lastRunAt ? ` · last ${fmtWhen(r.lastRunAt, r.schedule?.type === "daily" ? state.timezone : "")}` : ""}${who}</div>
          </div>
        </div>
        <p class="routine-body">${escapeHtml(previewRoutine(r.instruction))}</p>
        <div class="routine-actions">
          <button class="pill" data-act="toggle-routine" data-id="${r.id}">${on ? "Pause" : "Resume"}</button>
          <button class="pill" data-act="edit-routine" data-id="${r.id}">Edit</button>
          <button class="pill danger-pill" data-act="delete-routine" data-id="${r.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

function routineClock(hour: number | undefined, minute: number | undefined): string {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) return "";
  const twelveHour = h % 12 || 12;
  return `${twelveHour}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function routineCadence(r: Routine | null | undefined): string {
  const list = clientTriggers(r);
  if (list.length) return list.map((t) => clientTriggerLabel(t)).join(" · ");
  const schedule = r?.schedule;
  if (schedule?.type === "daily") {
    const clock = routineClock(schedule.hour, schedule.minute);
    if (clock) return `Every day at ${clock} (${state.timezone || "local time"})`;
  }
  const mins = Math.max(1, Math.round((r?.intervalMs || 0) / 60000));
  return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
}


function fmtWhen(ts: number | undefined, timeZone = ""): string {
  const n = Number(ts);
  if (!n) return "—";
  const d = new Date(n);
  const now = Date.now();
  const ago = Math.max(0, now - n);
  if (ago < 60_000) return "just now";
  if (ago < 3600_000) return `${Math.round(ago / 60_000)} min ago`;
  const zone = timeZone || undefined;
  if (ago < 86400_000) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: zone });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
}

function previewRoutine(text: string | undefined): string {
  const t = String(text || "").trim();
  if (!t) return "";
  const first = t.split(/\n/).find((l) => l.trim()) || t;
  if (t.length <= 180) return first;
  return `${first.slice(0, 160).trim()}…`;
}

function paintModal(): void {
  const host = $("#modal-host");
  if (!host) return;
  const bot = currentBot();
  const key = `${state.modal || ""}|${state.section}|${state.editingRoutineId || ""}|${activeBotId() || ""}|${state.account?.view || ""}|${state.vaultGroup || ""}|${state.vaultEditId || ""}|${state.vaultNaming ? "1" : "0"}|${state.computerId || ""}|${state.computerAttach ? "1" : "0"}|${state.deleteBotId || ""}|${state.computerView}|${state.computerSort}|${state.createSku || ""}|${state.createCloudKind || ""}|${state.createCloudPay ? "1" : "0"}|${state.claudeAuth?.awaitingCode ? "code" : ""}|${state.claudeAuth?.busy ? "busy" : ""}`;
  if (!state.modal) {
    host.innerHTML = "";
    delete host.dataset.key;
    return;
  }
  const active = document.activeElement;
  const typing = host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || "");
  // Never rebuild a form modal in place — SSE/health render() would wipe
  // the fields and steal the Create click onto the overlay.
  const keepForm =
    typing ||
    state.modal === "routine" ||
    (state.modal === "create" && !(isLiveCloud() && state.createCloudKind === "bot")) ||
    state.modal === "create-team" ||
    state.modal === "vault" ||
    state.modal === "lol" ||
    state.modal === "claude-code";
  if (host.dataset.key === key && host.innerHTML && keepForm) return;
  host.dataset.key = key;
  if (state.modal === "create") host.innerHTML = createBotHtml();
  else if (state.modal === "create-team") host.innerHTML = createTeamHtml();
  else if (state.modal === "vault") {
    try {
      host.innerHTML = vaultHtml();
    } catch (err) {
      host.innerHTML = `<div class="overlay"><div class="modal" data-modal="1"><div class="sbody">
        <button type="button" class="close" data-act="close-modal">${iconClose()}</button>
        <h2>Password vault</h2>
        <p class="error">${escapeHtml((err as CaughtError | undefined)?.message || "Could not render the vault.")}</p>
      </div></div></div>`;
    }
  }
  else if (state.modal === "lol") host.innerHTML = lolHtml();
  else if (state.modal === "computers") host.innerHTML = computersHtml();
  else if (state.modal === "delete-bot") host.innerHTML = deleteBotHtml();
  else if (state.modal === "claude-code") host.innerHTML = claudeCodeHtml();
  else if (state.modal === "settings") host.innerHTML = settingsHtml();
  else if (state.modal === "advanced" && bot) host.innerHTML = advancedHtml(bot);
  else if (state.modal === "routine" && bot) {
    host.innerHTML = routineEditorHtml(bot);
  } else host.innerHTML = "";
  if (state.modal === "claude-code" && state.claudeAuth?.awaitingCode) {
    requestAnimationFrame(() => $<HTMLInputElement>("#claude-auth-code")?.focus());
  }
}

function advancedHtml(bot: Bot): string {
  const row = (label: string, value: unknown) =>
    `<div class="adv-row"><div class="muted">${escapeHtml(label)}</div><code class="adv-val" title="${escapeHtml(String(value || "—"))}">${escapeHtml(String(value || "—"))}</code></div>`;
  if (isCloudPlace() || bot?.place === "cloud") {
    const brain: BotBrain = bot.brain || state.cloudDraft?.brain || {};
    const desk: Partial<Computer> = bot.desk || {};
    const msgs = (bot.messages || []).filter((m) => !m.hidden && m.role !== "tool");
    return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(560px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Advanced</h2>
        <p class="muted" style="margin-top:-10px">Cloud desk. Nothing here is on this Mac.</p>
        <div class="adv-card">
          ${row("Desk", desk.id || bot.computerId || bot.id)}
          ${row("Name", bot.name)}
          ${row("Brain", brain.grokSignedIn ? "Grok OAuth" : brain.provider || "—")}
          ${row("Model", brain.model || bot.harness?.model || "—")}
          ${row("SKU", desk.sku || "—")}
          ${row("Status", desk.status || bot.vm?.status || "—")}
          ${row("IPv4", desk.ipv4 || "—")}
          ${row("Stream", desk.streamUrl || bot.vm?.streamUrl || "—")}
          ${row("Messages", String(msgs.length))}
        </div>
      </div>
    </div>
  </div>`;
  }
  const h = resolvedHarness(bot);
  const s: BotStorage = bot.storage || {};
  const local: BotHarness = bot.harness || {};
  const base =
    local.provider === "lmstudio"
      ? "http://127.0.0.1:1234/v1"
      : local.provider === "ollama"
        ? "http://127.0.0.1:11434/v1"
        : isCliHost(h.provider)
          ? "host CLI"
          : state.settings?.harness?.baseUrl || "https://api.x.ai/v1";
  const msgs = bot.messages || [];
  const visible = msgs.filter((m) => !m.hidden && m.role !== "tool");
  const routineN = (bot.routines || []).length;
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(560px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Advanced</h2>
        <p class="muted" style="margin-top:-10px">This conversation’s storage and session.</p>
        <div class="adv-card">
          ${row("Conversation", s.sessionId || bot.id)}
          ${row("Harness session", s.harnessSessionId || bot.harnessSessionId || bot.grokSessionId || bot.id)}
          ${row("Bot", bot.name)}
          ${row("Model", h.model || "—")}
          ${row("Harness", h.provider || "—")}
          ${row("API base", base)}
          ${row("Routines", routineN ? String(routineN) : "none")}
          ${row("History file", s.conversationFile || "")}
          ${row("Bots file", s.botsFile || "")}
          ${row("Screenshot file", s.screensFile || "")}
          ${row("Data folder", s.dataDir || "")}
          ${row("Messages", String(visible.length))}
          ${row("Created", bot.createdAt ? new Date(bot.createdAt).toLocaleString() : "—")}
          ${row("Updated", bot.updatedAt ? new Date(bot.updatedAt).toLocaleString() : "—")}
          ${row("Computer", bot.vm?.status || "idle")}
          ${row("Container", bot.vm?.container || "—")}
          ${row("Stream port", bot.vm?.novncPort ? String(bot.vm.novncPort) : "—")}
          ${row("VM log", (s.dataDir ? `${s.dataDir}/traces/${bot.id}.jsonl` : `data/traces/${bot.id}.jsonl`))}
        </div>
        <p class="muted">Outside tunnel = screenshot/click. Inside tunnel = shell in the VM. Host Mac is never a target.</p>
      </div>
    </div>
  </div>`;
}

function timeSlots(): { hour: number; minute: number; label: string }[] {
  const rows = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) rows.push({ hour: h, minute: m, label: routineClock(h, m) });
  }
  return rows;
}

function newTriggerId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeClientTrigger(raw: RawTrigger | null | undefined): Trigger | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").toLowerCase();
  const times = Array.isArray(raw.times)
    ? raw.times
        .map((t) => ({ hour: Number(t.hour), minute: Number(t.minute) }))
        .filter((t) => Number.isInteger(t.hour) && t.hour >= 0 && t.hour <= 23 && Number.isInteger(t.minute) && t.minute >= 0 && t.minute <= 59)
    : [];
  const id = raw.id || newTriggerId();
  if (kind === "hourly") return { id, kind: "hourly", intervalMs: 3600_000 };
  if (kind === "interval") {
    const intervalMs = Number(raw.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < 60_000) return null;
    return { id, kind: "interval", intervalMs };
  }
  if (kind === "daily" && times.length) return { id, kind: "daily", times };
  if (kind === "weekdays" && times.length) return { id, kind: "weekdays", times };
  if (kind === "weekly") {
    const weekday = ((Number(raw.weekday) % 7) + 7) % 7;
    return { id, kind: "weekly", weekday: Number.isInteger(weekday) ? weekday : 1, times: times.length ? times : [{ hour: 9, minute: 0 }] };
  }
  if (kind === "monthly") {
    return { id, kind: "monthly", monthDay: Math.min(31, Math.max(1, Number(raw.monthDay) || 1)), times: times.length ? times : [{ hour: 9, minute: 0 }] };
  }
  if (kind === "advanced") {
    const months = Array.isArray(raw.months) ? raw.months.map(Number).filter((n) => n >= 1 && n <= 12) : [];
    return { id, kind: "advanced", months, days: raw.days === "weekdays" ? "weekdays" : "every", times: times.length ? times : [{ hour: 8, minute: 0 }] };
  }
  if (kind === "cron" && String(raw.cron || "").trim()) return { id, kind: "cron", cron: String(raw.cron).trim() };
  return null;
}

function clientTriggers(r: Routine | null | undefined): Trigger[] {
  if (!r) return [];
  // filter(Boolean) drops exactly the nulls normalizeClientTrigger answers for
  // a row it does not recognise; TS cannot read that predicate.
  if (Array.isArray(r.triggers) && r.triggers.length) return r.triggers.map(normalizeClientTrigger).filter(Boolean) as Trigger[];
  if (r.schedule?.type === "daily") {
    return [{ id: `${r.id || "d"}-cal`, kind: "daily", times: [{ hour: r.schedule.hour, minute: r.schedule.minute }] }];
  }
  if (Number(r.intervalMs) > 0) {
    const intervalMs = Number(r.intervalMs);
    return [{ id: `${r.id || "i"}-int`, kind: intervalMs === 3600_000 ? "hourly" : "interval", intervalMs }];
  }
  return [];
}

function clientTriggerLabel(t: RawTrigger): string {
  const row = normalizeClientTrigger(t);
  if (!row) return "Schedule";
  const clocks = (row.times || []).map((x) => routineClock(x.hour, x.minute)).filter(Boolean);
  const clock = clocks.join(", ");
  if (row.kind === "hourly") return "Every hour";
  if (row.kind === "interval") {
    const mins = Math.max(1, Math.round(row.intervalMs / 60_000));
    if (mins % 60 === 0) {
      const hours = mins / 60;
      return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  if (row.kind === "daily") return `Every day at ${clock}`;
  if (row.kind === "weekdays") return `Weekdays at ${clock}`;
  if (row.kind === "weekly") {
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][row.weekday] || "week";
    return `Every week on ${day} at ${clock}`;
  }
  if (row.kind === "monthly") return `Every month on the ${row.monthDay} at ${clock}`;
  if (row.kind === "advanced") return clock ? `Advanced · ${clock}` : "Advanced";
  if (row.kind === "cron") return row.cron;
  return "Schedule";
}

function fmtRunStamp(ts: number | undefined): string {
  const n = Number(ts);
  if (!n) return "—";
  const zone = state.timezone || undefined;
  const d = new Date(n);
  const now = new Date();
  const dayFmt: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", year: "numeric", timeZone: zone };
  const today = now.toLocaleDateString([], dayFmt);
  const that = d.toLocaleDateString([], dayFmt);
  const yest = new Date(now.getTime() - 86400_000).toLocaleDateString([], dayFmt);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: zone });
  if (that === today) return `Today at ${time}`;
  if (that === yest) return `Yesterday at ${time}`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
}

function historyCheck(): string {
  return `<svg class="re-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
}

function bindRoutineFields(): void {
  const host = $(".routine-editor");
  if (!host || host.dataset.live === "1") return;
  host.dataset.live = "1";
  host.addEventListener("input", (e) => {
    if ((e.target as HTMLElement | null)?.id === "rn" || (e.target as HTMLElement | null)?.id === "ri") scheduleRoutineSave();
  });
}

let routineSaveTimer = 0;
function scheduleRoutineSave(): void {
  clearTimeout(routineSaveTimer);
  routineSaveTimer = setTimeout(() => persistRoutine({ close: false }), 600);
}

function paintRoutineWhen(): void {
  const host = $("#re-when");
  if (!host) return;
  // Same predicate as clientTriggers: filter(Boolean) drops only the nulls.
  const rows = (state.routineTriggers || []).map(normalizeClientTrigger).filter(Boolean) as Trigger[];
  state.routineTriggers = rows;
  const chip = (t: Trigger) =>
    `<button type="button" class="re-chip" data-act="sched-edit" data-id="${escapeHtml(t.id)}" title="Edit or remove">
      <span class="re-chip-ico">${iconClock()}</span>
      <span>${escapeHtml(clientTriggerLabel(t))}</span>
      <span class="re-chip-x" data-act="sched-remove" data-id="${escapeHtml(t.id)}" title="Remove">×</span>
    </button>`;
  host.innerHTML = `${rows.map(chip).join("")}
    <button type="button" class="re-chip re-add" data-act="sched-open">
      <span class="re-chip-ico">${iconPlus()}</span>
      <span>Add another</span>
    </button>`;
  bindRoutineFields();
}

function ensureSchedHost(): HTMLElement {
  let host = $("#sched-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "sched-host";
    document.body.appendChild(host);
  }
  return host;
}

function schedItem(act: string, label: string, extra = "", data = ""): string {
  return `<button type="button" class="sched-item ${extra}" data-act="${act}" ${data}><span>${label}</span>${extra.includes("has-sub") ? `<span class="ctx-caret">›</span>` : ""}</button>`;
}

function paintSchedPop(): void {
  const host = ensureSchedHost();
  const pop = state.schedPop;
  if (!pop || state.modal !== "routine") {
    host.innerHTML = "";
    return;
  }
  const left = Math.min(pop.x, window.innerWidth - 240);
  const top = Math.min(pop.y, window.innerHeight - 80);
  const menu = (inner: string, x: number, y: number) => `<div class="sched-menu" style="top:${y}px;left:${x}px">${inner}</div>`;
  const kinds = `${schedItem("sched-kind", "Every hour", "", `data-kind="hourly"`)}
    ${schedItem("sched-kind", "Every day", "has-sub", `data-kind="daily"`)}
    ${schedItem("sched-kind", "Weekdays", "has-sub", `data-kind="weekdays"`)}
    ${schedItem("sched-kind", "Every week", "has-sub", `data-kind="weekly"`)}
    ${schedItem("sched-kind", "Every month", "has-sub", `data-kind="monthly"`)}
    ${schedItem("sched-kind", "Interval", "", `data-kind="interval"`)}
    ${schedItem("sched-kind", "Advanced…", "", `data-kind="advanced"`)}`;
  const times = timeSlots()
    .map(
      (t) =>
        `<button type="button" class="sched-item" data-act="sched-time" data-hour="${t.hour}" data-minute="${t.minute}">${t.label}</button>`,
    )
    .join("");
  let html = "";
  if (pop.panel === "root") {
    html = menu(`${schedItem("sched-kind-open", "On a schedule", "has-sub")}`, left, top);
  } else if (pop.panel === "kinds") {
    html = `<div class="sched-fly" style="top:${top}px;left:${left}px"><div class="sched-menu">${kinds}</div></div>`;
  } else if (pop.panel === "times") {
    html = `<div class="sched-fly" style="top:${Math.max(12, top - 80)}px;left:${Math.max(12, left - 168)}px">
      <div class="sched-menu sched-times">${times}</div>
      <div class="sched-menu">${kinds}</div>
    </div>`;
  } else if (pop.panel === "interval") {
    const n = pop.intervalN || 2;
    const unit = pop.intervalUnit || "hours";
    html = `<div class="sched-fly" style="top:${top}px;left:${Math.max(12, left - 220)}px">
      <div class="sched-menu sched-interval">
        <div class="sched-interval-row">
          <span>Every</span>
          <input class="field" id="sched-n" type="number" min="1" value="${n}" />
          <select class="field" id="sched-unit">
            <option value="minutes" ${unit === "minutes" ? "selected" : ""}>minutes</option>
            <option value="hours" ${unit === "hours" ? "selected" : ""}>hours</option>
          </select>
        </div>
        <button type="button" class="pill primary" data-act="sched-interval-add">Add</button>
      </div>
      <div class="sched-menu">${kinds}</div>
    </div>`;
  } else if (pop.panel === "advanced" || pop.panel === "custom") {
    const adv = pop.advanced || { months: [], days: "every", times: [{ hour: 8, minute: 0 }], cron: "0 8 * * *" };
    const mode = pop.panel === "custom" ? "custom" : "advanced";
    const monthOpts = ["Any month", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthVal = adv.months?.[0] || 0;
    const time0 = adv.times?.[0] || { hour: 8, minute: 0 };
    html = `<div class="sched-card" style="top:${Math.min(top, window.innerHeight - 280)}px;left:${Math.min(left, window.innerWidth - 340)}px">
      <div class="sched-card-head">
        <select class="sched-mode" data-act="sched-mode">
          <option value="advanced" ${mode === "advanced" ? "selected" : ""}>Advanced</option>
          <option value="custom" ${mode === "custom" ? "selected" : ""}>Custom</option>
        </select>
      </div>
      ${
        mode === "custom"
          ? `<input class="field" id="sched-cron" value="${escapeHtml(adv.cron || "0 8 * * *")}" placeholder="0 8 * * *" />`
          : `<div class="sched-adv-grid">
        <span>Months</span>
        <select id="sched-months" class="field">
          ${monthOpts.map((name, i) => `<option value="${i}" ${monthVal === i ? "selected" : ""}>${name}</option>`).join("")}
        </select>
        <span>Days</span>
        <select id="sched-days" class="field">
          <option value="every" ${adv.days !== "weekdays" ? "selected" : ""}>Every day</option>
          <option value="weekdays" ${adv.days === "weekdays" ? "selected" : ""}>Weekdays</option>
        </select>
        <span>Time</span>
        <div class="sched-adv-time">
          <span class="muted">At times</span>
          <select id="sched-adv-time" class="field">
            ${timeSlots().map((t) => `<option value="${t.hour}:${t.minute}" ${t.hour === time0.hour && t.minute === time0.minute ? "selected" : ""}>${t.label}</option>`).join("")}
          </select>
          <button type="button" class="re-add-time" data-act="sched-add-time">+ Add time</button>
        </div>
      </div>`
      }
      <button type="button" class="pill primary" data-act="sched-advanced-add">Add</button>
    </div>`;
  }
  host.innerHTML = html;
  if (pop.panel === "interval") setTimeout(() => $<HTMLInputElement>("#sched-n")?.focus(), 20);
  if (pop.panel === "custom") setTimeout(() => $<HTMLInputElement>("#sched-cron")?.focus(), 20);
}

function openSchedPop(el: Element | null | undefined, panel = "root"): void {
  const r = (el || $("#re-when") || document.body).getBoundingClientRect();
  state.schedPop = {
    panel,
    x: r.left,
    y: r.bottom + 6,
    timeKind: "daily",
    intervalN: 2,
    intervalUnit: "hours",
    advanced: { months: [], days: "every", times: [{ hour: 8, minute: 0 }], cron: "0 8 * * *" },
    editId: null,
  };
  paintSchedPop();
}

function addRoutineTrigger(partial: RawTrigger): void {
  const id = partial.id || state.schedPop?.editId || newTriggerId();
  const row = normalizeClientTrigger({ ...partial, id });
  if (!row) return;
  const rest = (state.routineTriggers || []).filter((t) => t.id !== row.id);
  state.routineTriggers = [...rest, row];
  state.schedPop = null;
  paintRoutineWhen();
  paintSchedPop();
  persistRoutine({ close: false });
}

function removeRoutineTrigger(id: string | undefined): void {
  state.routineTriggers = (state.routineTriggers || []).filter((t) => t.id !== id);
  paintRoutineWhen();
  persistRoutine({ close: false });
}

function routineEditorHtml(bot: Bot): string {
  const rows = isCloudPlace() ? cloudRoutineRows(bot) : bot.routines || [];
  const r = rows.find((x) => x.id === state.editingRoutineId);
  const isNew = !r;
  const on = r?.enabled !== false;
  const runs = Array.isArray(r?.runs) ? [...r.runs].reverse().slice(0, 12) : [];
  return `<div class="overlay">
    <div class="modal routine-modal" data-modal="1">
      <div class="sbody routine-editor">
        <button class="close" data-act="close-modal">×</button>
        <div class="re-toolbar">
          <label class="re-active">
            <button type="button" class="toggle ${on ? "on" : ""}" id="re-tog" data-act="routine-enabled" title="Active"><i></i></button>
            Active
          </label>
          <div class="re-toolbar-right">
            <button type="button" class="pill" data-act="delete-routine-editor">${isNew ? "Cancel" : "Delete"}</button>
            ${isCloudPlace() ? "" : `<button type="button" class="pill solid" data-act="test-routine">Test run</button>`}
          </div>
        </div>
        <label class="re-field">
          <span>Name</span>
          <input class="field re-input" id="rn" value="${escapeHtml(r?.name || "")}" placeholder="Name this job" />
        </label>
        <label class="re-field re-instruction">
          <span>Instruction</span>
          <textarea class="field re-input" id="ri" placeholder="Standing brief: who you are, what to check, how to reply, when to stop.">${escapeHtml(r?.instruction || "")}</textarea>
        </label>
        <div class="re-field">
          <span>When to run</span>
          <div id="re-when" class="re-when"></div>
        </div>
        <div class="re-field re-history">
          <span>Run history</span>
          ${
            runs.length
              ? `<div class="re-runs">${runs
                  .map(
                    (x) =>
                      `<div class="re-run"><span>${escapeHtml(fmtRunStamp(x.ts))}</span>${historyCheck()}</div>`,
                  )
                  .join("")}</div>`
              : `<p class="muted">No runs yet. They show up here each time this job fires.</p>`
          }
        </div>
      </div>
    </div>
  </div>`;
}


function appDefaultHarness(): { provider: string; model: string } {
  const h = state.settings?.harness || {};
  const provider = h.provider || "grok-build";
  const model = String(h.model || "").trim();
  return { provider, model };
}

function isCliHost(id: string | undefined): boolean {
  return id === "claude" || id === "codex" || id === "hermes" || id === "cursor";
}

function harnessDisplayName(id: string | undefined): string {
  return (
    {
      "grok-build": "Grok Build",
      hermes: "Hermes",
      claude: "Claude",
      codex: "Codex",
      cursor: "Cursor",
      ollama: "Ollama",
      lmstudio: "LM Studio",
      spacexai: "SpaceXAI",
      default: "App default",
    }[id as string] || id || "Harness"
  );
}

function identityStatusLabel(status: string | undefined): string {
  if (status === "signed_in") return "Signed in";
  if (status === "expired") return "Session expired";
  if (status === "not_running") return "Not running";
  if (status === "not_installed") return "Not installed";
  return "Not signed in";
}

function cloudIdentityRows(): IdentityRow[] {
  return (state.identities || []).filter((row) => row.place === "cloud");
}

/** Worker team rows use shorter ids (`cloud-grok`); the desktop pool uses `cloud-grok-brain`, etc. */
function workerCloudIdentityId(localId: string): string {
  if (!localId) return "";
  if (localId === "cloud-grok-brain" || localId.startsWith("cloud-grok")) return "cloud-grok";
  if (localId.startsWith("cloud-claude")) return "cloud-claude";
  if (localId.startsWith("cloud-api-")) return "cloud-key";
  return localId;
}

function localCloudIdentityId(workerId: string, computerId?: string): string {
  const desk = String(computerId || "").replace(/^cloud[:-]/, "").trim();
  if (workerId === "cloud-grok") return "cloud-grok-brain";
  if (workerId === "cloud-claude") return desk ? `cloud-claude-${desk}` : "cloud-claude";
  if (workerId === "cloud-key") {
    const api = cloudIdentityRows().find((row) => row.id.startsWith("cloud-api-"));
    return api?.id || "cloud-api-spacexai";
  }
  return workerId;
}

function identityById(id: string | undefined): IdentityRow | undefined {
  if (!id) return undefined;
  const rows = state.identities || [];
  return (
    rows.find((row) => row.id === id) ||
    rows.find((row) => workerCloudIdentityId(row.id) === id) ||
    rows.find((row) => row.id === localCloudIdentityId(id))
  );
}

function defaultModelForProvider(provider: string): string {
  if (provider === "grok-build" || provider === "grok-oauth") return "grok-4.6";
  if (provider === "claude") return "haiku";
  if (isCliHost(provider)) return "default";
  return provider;
}

function modelForIdentityProvider(provider: string, model: string | undefined): string {
  const p = provider === "grok-oauth" ? "grok-build" : provider;
  const m = String(model || "").trim();
  if (p === "grok-build") return /^grok/i.test(m) ? m : "grok-4.6";
  if (p === "claude") return !m || /^grok/i.test(m) ? "haiku" : m;
  return m || defaultModelForProvider(p);
}

function harnessFromIdentity(identity: IdentityRow | undefined, bot?: Bot): { provider: string; model: string } {
  if (identity) {
    const provider = identity.provider === "grok-oauth" ? "grok-build" : identity.provider;
    return { provider, model: modelForIdentityProvider(provider, identity.model) };
  }
  const provider = bot?.harness?.provider === "grok-oauth" ? "grok-build" : bot?.harness?.provider || "grok-build";
  return { provider, model: modelForIdentityProvider(provider, bot?.harness?.model) };
}

function resolveBotIdentity(bot: Bot): IdentityRow | undefined {
  const cloudRows = cloudIdentityRows();
  const want = String(bot.identityId || "").trim();
  if (want) {
    const hit = identityById(want);
    if (hit?.place === "cloud") return hit;
  }
  if (!isCloudPlace()) return want ? identityById(want) : undefined;
  const provider = bot.harness?.provider;
  if (provider === "grok-oauth" || provider === "grok-build") {
    return cloudRows.find((row) => row.provider === "grok-build");
  }
  if (provider) return cloudRows.find((row) => row.provider === provider);
  return cloudRows[0];
}

function editorHarnessFromIdentity(bot?: Bot): { provider: string; model: string; identityId: string } {
  const picked = identityById($<ValueEl>("#bid")?.value) || (bot ? resolveBotIdentity(bot) : undefined);
  const harness = harnessFromIdentity(picked, bot);
  return { ...harness, identityId: picked?.id || "" };
}

function identityOptions(selected: string | undefined, providerFallback?: string, bot?: Bot): string {
  const cloud = isCloudPlace();
  const rows = cloud ? cloudIdentityRows() : (state.identities || []).filter((row) => row.place !== "cloud");
  const resolved = bot ? resolveBotIdentity(bot) : undefined;
  const effective = selected || resolved?.id || "";
  if (cloud) {
    if (!rows.length) {
      return `<option value="" selected>No cloud identities — sign in under Settings → Identities</option>`;
    }
    return rows
      .map((row) => {
        const on =
          effective === row.id ||
          workerCloudIdentityId(row.id) === effective ||
          row.id === localCloudIdentityId(effective, bot?.computerId);
        const who = row.subject ? ` · ${row.subject}` : "";
        const status =
          row.status === "signed_in" ? " ✓" : row.status === "expired" ? " · expired" : row.status ? ` · ${identityStatusLabel(row.status)}` : "";
        return `<option value="${escapeHtml(row.id)}" ${on ? "selected" : ""}>${escapeHtml(`${row.label}${who}${status}`)}</option>`;
      })
      .join("");
  }
  const opts = [`<option value="" ${!effective ? "selected" : ""}>App default</option>`];
  for (const row of rows) {
    const on = effective === row.id || (!effective && row.provider === providerFallback && row.runtimeRef === "host");
    const who = row.subject ? ` · ${row.subject}` : "";
    opts.push(
      `<option value="${escapeHtml(row.id)}" ${on ? "selected" : ""}>${escapeHtml(`${row.label}${who}`)}</option>`,
    );
  }
  return opts.join("");
}

function harnessProviderOptions(selected: string | undefined): string {
  const def = appDefaultHarness();
  const defModel = def.model || (isCliHost(def.provider) ? "default" : "grok-4.6");
  const defLabel = `${harnessDisplayName(def.provider)} · ${defModel}`;
  const catalog = (state.identityCatalog || []).length
    ? state.identityCatalog.map((item) => [item.id, item.label] as [string, string])
    : ([
        ["grok-build", "Grok Build"],
        ["hermes", "Hermes"],
        ["claude", "Claude"],
        ["codex", "Codex"],
        ["cursor", "Cursor"],
        ["ollama", "Ollama"],
        ["lmstudio", "LM Studio"],
        ["spacexai", "SpaceXAI"],
        ["openrouter", "OpenRouter"],
        ["openai", "OpenAI"],
        ["custom", "Custom API"],
      ] as [string, string][]);
  const ids = [["default", defLabel] as [string, string], ...catalog];
  const seen = new Set<string>();
  return ids
    .filter(([id]) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(([id, label]) => `<option value="${id}" ${selected === id ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function modelPickerHtml(provider: string, selected: string, { id = "cm" }: { id?: string } = {}): string {
  const models = localModels(provider);
  const kind = modelFieldKind(provider, models);
  const detected = state.localHarness?.[provider];
  if (kind === "select") {
    const value = pickListedModel(provider, selected, models);
    const label =
      provider === "lmstudio"
        ? "LM Studio"
        : provider === "ollama"
          ? "Ollama"
          : provider === "hermes"
            ? "Hermes"
            : provider === "codex"
              ? "Codex"
            : provider === "cursor"
              ? "Cursor"
            : provider === "spacexai"
              ? "SpaceXAI"
              : provider === "grok-build"
                ? "Grok Build"
                : provider;
    return `<select class="field" id="${id}">${models
      .map((m) => `<option value="${escapeHtml(m)}" ${value === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
      .join("")}</select>
      <div class="muted">${escapeHtml(label)} · ${models.length} available</div>`;
  }
  if (kind === "detect") {
    return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="${
      detected?.ok ? "no chat models detected" : "start the app to list models"
    }" />
      <div class="muted">${detected?.ok ? "Running, but no chat models yet." : "Not detected. Start the app, then Refresh."}</div>
      <button type="button" class="pill" data-act="refresh-local-harness">Refresh models</button>`;
  }
  if (kind === "cli") {
    return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="default" />`;
  }
  if (kind === "app-default") {
    const def = appDefaultHarness();
    const model =
      selected ||
      def.model ||
      (isCliHost(def.provider) ? "default" : "grok-4.6");
    return `<div class="field field-static">${escapeHtml(model)}</div>
      <input type="hidden" id="${id}" value="" />
      <div class="muted">${escapeHtml(harnessDisplayName(def.provider))} from Settings. Pick a harness above to change it.</div>`;
  }
  return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="grok-4.6" />`;
}

function snapshotCreateForm(): void {
  const n = $<ValueEl>("#cn")?.value;
  const d = $<ValueEl>("#cd")?.value;
  const m = $<ValueEl>("#cm")?.value;
  const h = $<ValueEl>("#ch")?.value;
  if (n != null) state.createName = n;
  if (d != null) state.createDesc = d;
  if (m != null) state.createModel = m;
  if (h != null) state.createHarness = h;
}

function resetCreateForm(): void {
  state.createFace = "think";
  state.createHarness = "default";
  state.createModel = "";
  state.createName = "";
  state.createDesc = "";
  state.createSku = state.createSku || "vm.4g";
  state.createCloudKind = "bot";
  state.createCloudPay = false;
}

function rebuildCreateModal(): void {
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  paintModal();
  refreshAvatars();
}

function computerStateLabel(st: string | undefined, row: Computer | null | undefined): string {
  if (row?.stuck || row?.stale) return st === "running" ? "Running?" : "Can't see";
  if (st === "running") return "Running";
  if (st === "paused") return "Paused";
  if (st === "exited" || st === "stopped") return "Stopped";
  if (st === "missing") return "Missing";
  if (st === "unknown") return "Can't see";
  return st || "Unknown";
}

function harnessLabel(id: string | undefined): string {
  return (
    { "grok-build": "Grok Build", hermes: "Hermes", claude: "Claude", codex: "Codex", cursor: "Cursor", ollama: "Ollama", lmstudio: "LM Studio", spacexai: "SpaceXAI" }[id as string] ||
    id ||
    ""
  );
}

function sortedComputers(): Computer[] {
  const rows = [...viewComputers()];
  const rank: Record<string, number> = { running: 0, paused: 1, starting: 2, exited: 3, stopped: 3, missing: 4 };
  const key = state.computerSort || "name";
  rows.sort((a, b) => {
    if (key === "mem") {
      const am = state.computerStats[a.container as string]?.memBytes || 0;
      const bm = state.computerStats[b.container as string]?.memBytes || 0;
      return bm - am;
    }
    if (key === "status") return (rank[a.status as string] ?? 9) - (rank[b.status as string] ?? 9) || a.name.localeCompare(b.name);
    if (key === "bot") return String(a.attachedBotName || "zzz").localeCompare(String(b.attachedBotName || "zzz"));
    if (key === "harness") return String(a.harness?.label || "zzz").localeCompare(String(b.harness?.label || "zzz"));
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return rows;
}

function memBarHtml(container: string | undefined, compact = false): string {
  const st = state.computerStats[container as string];
  const pct = Math.max(0, Math.min(100, Number(st?.memPct) || 0));
  const label = st?.mem ? st.mem.replace(/iB$/i, "B") : "—";
  const tone = pct >= 85 ? "hot" : pct >= 60 ? "warm" : "ok";
  return `<div class="cmem ${compact ? "sm" : ""}" data-cmem="${escapeHtml(container)}">
    <div class="cmem-top"><span>RAM</span><span data-cmem-label>${escapeHtml(label)}</span></div>
    <div class="cmem-track"><i class="cmem-fill ${tone}" data-cmem-fill style="width:${pct}%"></i></div>
  </div>`;
}

function harnessPill(h: BotHarness | null | undefined): string {
  if (!h?.provider) return `<span class="hpill muted">No harness</span>`;
  return `<span class="hpill hpill-${escapeHtml(h.provider)}" title="${escapeHtml(h.model || "")}">${escapeHtml(
    h.label || harnessLabel(h.provider),
  )}</span>`;
}

function computerPreviewHtml(c: Computer): string {
  const src = c.previewUrl || (c.previewBotId || c.attachedBotId || c.lastBotId ? `/api/bots/${c.previewBotId || c.attachedBotId || c.lastBotId}/screen` : "");
  const tick = state.previewTick || 0;
  return `<div class="cprev">
    ${src ? `<img alt="" src="${src}${src.includes("?") ? "&" : "?"}t=${tick}" onerror="this.style.display='none'" />` : ""}
    <div class="cprev-empty">${
      c.kind === "cloud-draft" || c.draft
        ? "Draft desk"
        : c.stuck || c.stale
          ? "Can't reach Docker"
          : c.status === "running" || c.status === "starting"
            ? "No preview yet"
            : "Desk is off"
    }</div>
  </div>`;
}

function computerBotLink(c: Computer): string {
  if (!c.attachedBotId) return `<span class="crow-meta">Unattached</span>`;
  return `<button type="button" class="clink" data-act="open-computer-bot" data-id="${escapeHtml(c.attachedBotId)}" title="Open ${escapeHtml(c.attachedBotName || "Bot")}">${escapeHtml(
    c.attachedBotName || "Bot",
  )}</button>`;
}

function computerActions(row: Computer): string {
  if (isCloudPlace() || row.kind === "cloud-draft") {
    return `<button type="button" class="danger" data-act="computer-act" data-do="destroy" data-id="${row.id}">Destroy draft</button>`;
  }
  return `
    ${
      row.status === "paused"
        ? `<button type="button" class="pill primary" data-act="computer-act" data-do="resume" data-id="${row.id}">Resume</button>`
        : row.status === "running"
          ? `<button type="button" class="pill" data-act="computer-act" data-do="pause" data-id="${row.id}">Pause</button>`
          : `<button type="button" class="pill primary" data-act="computer-act" data-do="start" data-id="${row.id}">Start</button>`
    }
    ${
      row.status === "running" || row.status === "paused"
        ? `<button type="button" class="pill" data-act="computer-act" data-do="reboot" data-id="${row.id}">Reboot</button>
        <button type="button" class="pill" data-act="computer-act" data-do="stop" data-id="${row.id}">Stop</button>`
        : ""
    }
    ${
      row.attachedBotId
        ? `<button type="button" class="pill" data-act="computer-act" data-do="detach" data-id="${row.id}">Detach</button>`
        : `<button type="button" class="pill" data-act="computer-attach-open" data-id="${row.id}">Attach to…</button>`
    }
    <button type="button" class="danger" data-act="computer-act" data-do="destroy" data-id="${row.id}">Destroy</button>`;
}

function formatDeskBytes(n: number | undefined): string {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDeskImageWhen(ms: number | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function computerSnapshotsHtml(row: Computer): string {
  if (isCloudPlace() || row.kind === "cloud-draft") return "";
  const busy = state.computerImagesBusy;
  const images = (state.computerImages || []).filter((img) => img.computerId === row.id);
  const list = images.length
    ? images
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map(
          (img) => `<div class="csnap-row">
          <div class="csnap-meta">
            <span class="csnap-when">${escapeHtml(formatDeskImageWhen(img.createdAt))}</span>
            <span class="csnap-size">${escapeHtml(formatDeskBytes(img.bytes))}</span>
            <span class="csnap-note">${escapeHtml(img.note || "")}</span>
          </div>
          <div class="csnap-acts">
            <button type="button" class="pill" data-act="desk-restore" data-id="${escapeHtml(row.id)}" data-image="${escapeHtml(img.id)}" ${busy ? "disabled" : ""}>Restore</button>
            <button type="button" class="pill danger-pill" data-act="desk-image-del" data-id="${escapeHtml(row.id)}" data-image="${escapeHtml(img.id)}" ${busy ? "disabled" : ""}>Delete</button>
          </div>
        </div>`,
        )
        .join("")
    : `<p class="muted csnap-empty">No snapshots yet.</p>`;
  return `<div class="csnaps">
    <div class="csnap-head">
      <button type="button" class="pill" data-act="desk-snap" data-id="${escapeHtml(row.id)}" ${busy ? "disabled" : ""}>${busy ? "Working…" : "Snapshot disk"}</button>
      <div class="sub">Saves this Linux desk’s files and Chrome profile. Chat stays in Sub8.</div>
    </div>
    <div class="csnap-list">${list}</div>
  </div>`;
}

function computersHtml(): string {
  const rows = sortedComputers();
  const id = state.computerId || rows[0]?.id || "";
  const row = rows.find((c) => c.id === id) || rows[0];
  const view = state.computerView === "list" ? "list" : "grid";
  const freeBots = viewBots().filter((b) => !b.hidden && !b.vm?.computerId);
  const attachPicker =
    row && state.computerAttach
      ? `<div class="cattach">${
          freeBots.length
            ? freeBots
                .map(
                  (b) =>
                    `<button type="button" class="pill" data-act="computer-attach" data-id="${row.id}" data-bot="${b.id}">${escapeHtml(b.name)}</button>`,
                )
                .join("")
            : `<span class="muted">Every Bot already has a computer.</span>`
        }</div>`
      : "";
  const cards = rows
    .map((c) => {
      const on = c.id === row?.id ? "on" : "";
      const st = c.status === "running" ? "ok" : c.status === "paused" ? "warn" : "bad";
      if (view === "list") {
        return `<div class="crow ${on}" data-act="computer-select" data-id="${c.id}">
          <div class="crow-main">
            <div class="crow-title">${escapeHtml(c.name)}</div>
            ${computerBotLink(c)}
          </div>
          <div class="crow-pills">${harnessPill(c.harness)}<span class="hbadge ${st}">${escapeHtml(computerStateLabel(c.status, c))}</span></div>
          ${memBarHtml(c.container, true)}
        </div>`;
      }
      return `<div class="ccard ${on}" data-act="computer-select" data-id="${c.id}">
        ${computerPreviewHtml(c)}
        <div class="ccard-body">
          <div class="crow-title">${escapeHtml(c.name)}</div>
          ${computerBotLink(c)}
          <div class="crow-pills">${harnessPill(c.harness)}<span class="hbadge ${st}">${escapeHtml(computerStateLabel(c.status, c))}</span></div>
          ${memBarHtml(c.container, true)}
        </div>
      </div>`;
    })
    .join("");
  const detail = row
    ? `<div class="cdetail">
        <input class="field" data-computer-name="${row.id}" value="${escapeHtml(row.name)}" />
        <span class="muted mono">${escapeHtml(row.container || "")}</span>
        ${row.attachedBotId ? computerBotLink(row) : ""}
        <div class="cdetail-acts">${computerActions(row)}</div>
        ${attachPicker}
        ${computerSnapshotsHtml(row)}
      </div>`
    : `<p class="muted">No computers yet. Start a Bot and it gets a desk.</p>`;
  return `<div class="overlay">
    <div class="modal computers-modal" data-modal="1">
      <div class="sbody" style="width:100%;display:flex;flex-direction:column;min-height:0">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        <div class="ctool">
          <div>
            <h2 style="margin:0">${isCloudPlace() ? "Cloud computers" : "Computers"}</h2>
            <p class="muted" style="margin:4px 0 0">${
              isCloudPlace()
                ? "Draft desks. Nothing is billed. Destroy is safe."
                : "Linux desks. Quit pauses them. They wake when you open Sub8."
            }</p>
          </div>
          <div class="ctool-right">
            ${
              isCloudPlace()
                ? `<button type="button" class="pill primary" data-act="cloud-new-computer">New computer</button>`
                : dockerMissing()
                  ? state.docker?.cli === false
                    ? `<button type="button" class="pill primary" data-act="install-docker" ${state.dockerBusy ? "disabled" : ""}>${
                        dockerInstalling() ? "Installing…" : "Install Docker"
                      }</button>`
                    : `<button type="button" class="pill primary" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
                        state.dockerBusy ? "Recovering…" : "Recover Docker"
                      }</button>`
                  : ""
            }
            <select class="field csort" data-computer-sort>
              <option value="name" ${state.computerSort === "name" ? "selected" : ""}>Name</option>
              <option value="mem" ${state.computerSort === "mem" ? "selected" : ""}>Memory</option>
              <option value="status" ${state.computerSort === "status" ? "selected" : ""}>State</option>
              <option value="bot" ${state.computerSort === "bot" ? "selected" : ""}>Bot</option>
              <option value="harness" ${state.computerSort === "harness" ? "selected" : ""}>Harness</option>
            </select>
            <div class="seg">
              <button type="button" class="seg-btn ${view === "grid" ? "on" : ""}" data-act="computer-view" data-id="grid">Grid</button>
              <button type="button" class="seg-btn ${view === "list" ? "on" : ""}" data-act="computer-view" data-id="list">List</button>
            </div>
          </div>
        </div>
        ${!isCloudPlace() && dockerMissing() ? dockerMissingHtml() : ""}
        <div class="cboard ${view}">${cards || `<div class="muted" style="padding:20px">${isCloudPlace() ? "No Cloud desk yet." : "None yet."}</div>`}</div>
        ${detail}
      </div>
    </div>
  </div>`;
}

function deleteBotHtml(): string {
  const bot = botById(state.deleteBotId) || state.bots.find((b) => b.id === state.deleteBotId);
  if (!bot) return "";
  if (isLiveCloud()) {
    const desk = viewComputers().find((c) => c.id === cloudDeskIdOf(bot)) || bot.desk;
    if (isCloudChief(bot)) {
      return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(480px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Delete ${escapeHtml(bot.name)}?</h2>
        <p class="muted">This is the Cloud desk bot. Removing it destroys the computer${
          desk ? ` (${escapeHtml(desk.name || desk.ipv4 || desk.id)})` : ""
        } and every teammate on it.</p>
        <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:14px">
          <button type="button" class="danger" data-act="delete-bot-go" data-keep="0">Delete the computer too</button>
          <div class="sub">The droplet is destroyed. This cannot be undone.</div>
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
    }
    return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(480px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Remove ${escapeHtml(bot.name)}?</h2>
        <p class="muted">They leave the Cloud rail. The desk stays; other teammates keep their screens.</p>
        <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:14px">
          <button type="button" class="danger" data-act="delete-bot-go" data-keep="1">Remove teammate</button>
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
  }
  if (isCloudPlace()) {
    const desk = viewComputers().find(
      (c) => c.id === bot.computerId || c.id === bot.vm?.computerId || c.attachedBotId === bot.id,
    );
    return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(480px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Remove ${escapeHtml(bot.name)}?</h2>
        <p class="muted">The Bot leaves the Cloud rail. The draft desk${
          desk ? ` (${escapeHtml(desk.name)})` : ""
        } stays.</p>
        <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:14px">
          <button type="button" class="danger" data-act="delete-bot-go" data-keep="1">Remove Bot</button>
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
  }
  const desk = viewComputers().find((c) => c.id === bot.vm?.computerId || c.attachedBotId === bot.id);
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(480px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Delete ${escapeHtml(bot.name)}?</h2>
        <p class="muted">The Bot leaves the rail. Choose what happens to its Linux computer${
          desk ? ` (${escapeHtml(desk.name)})` : ""
        }.</p>
        <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:14px">
          <button type="button" class="pill primary" data-act="delete-bot-go" data-keep="1">Keep the computer</button>
          <div class="sub">Desk stays under Computers, unattached. Files and logins stay. Attach it to another Bot later.</div>
          <button type="button" class="danger" data-act="delete-bot-go" data-keep="0">Delete the computer too</button>
          <div class="sub">The desk and its volume are destroyed. This cannot be undone.</div>
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

function createTeamHtml(): string {
  const provider = state.createHarness || "claude";
  return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Create team</h2>
        <p class="muted" style="margin-top:-8px">One shared desk. A chief and a worker who can talk to each other, each with their own Chrome window.</p>
        <label class="muted">Team name</label>
        <input class="field" id="tn" placeholder="Research" value="${escapeHtml(state.createName || "")}" autofocus />
        <label class="muted">Harness for both</label>
        <select class="field" id="th">${harnessProviderOptions(provider)}</select>
        <button type="button" class="pill primary" data-act="confirm-create-team" id="confirm-create-team" style="margin-top:16px">Create chief + worker</button>
      </div>
    </div>
  </div>`;
}

function dollarsFromCents(cents: number | undefined): string {
  return `$${Math.round(Number(cents || 0) / 100)}`;
}

function cloudSkuUsage(sku: string | undefined): CloudSkuUsage {
  const id = sku || state.createSku || "vm.4g";
  const row: Partial<CloudSku> = (state.cloudBilling?.skus || []).find((s) => s.id === id) || {};
  const used = Number(row.used) || 0;
  const entitled = Number(row.entitled != null ? row.entitled : row.quantity) || 0;
  const spare = Number(row.spare != null ? row.spare : Math.max(0, entitled - used));
  return { ...row, id, used, entitled, spare };
}

const CLOUD_SKU_FALLBACK: CloudSku[] = [
  { id: "vm.1g", name: "1 GB desk", unitAmountCents: 900, maxBots: 1, blurb: "One lightweight bot." },
  { id: "vm.2g", name: "2 GB desk", unitAmountCents: 1900, maxBots: 2, blurb: "A couple of bots." },
  { id: "vm.4g", name: "4 GB desk", unitAmountCents: 3900, maxBots: 4, highlight: true, blurb: "Default. A small team." },
  { id: "vm.8g", name: "8 GB desk", unitAmountCents: 7900, maxBots: 8, blurb: "A busy team." },
  { id: "vm.16g", name: "16 GB desk", unitAmountCents: 14900, maxBots: 16, blurb: "Pro. Lots of bots." },
];

function cloudSkuRows(): CloudSku[] {
  const skus = state.cloudBilling?.skus || [];
  if (skus.length) return skus;
  if (state.cloudBillingError) {
    return CLOUD_SKU_FALLBACK.map((s) => ({ ...s, used: 0, entitled: 0, spare: 0, paidQuantity: 0 }));
  }
  return [];
}

function cloudSkuPicksHtml(): string {
  const skus = cloudSkuRows();
  if (!skus.length) {
    return `<p class="muted">Loading plan…</p>`;
  }
  const err = state.cloudBillingError
    ? `<p class="muted">Could not load the live plan (${escapeHtml(state.cloudBillingError)}). Showing catalog prices. Retry create, or check Cloud.</p>`
    : "";
  return `${err}<div class="sku-picks">${skus
    .map((s) => {
      const u = cloudSkuUsage(s.id);
      const on = (state.createSku || "vm.4g") === s.id ? "on" : "";
      return `<button type="button" class="sku-pick ${on}" data-act="create-sku" data-id="${escapeHtml(s.id)}">
        <div class="sku-meta"><strong>${escapeHtml(s.name || s.id)}</strong><span>${dollarsFromCents(s.unitAmountCents)}/mo</span></div>
        <div class="muted">${u.used} of ${u.entitled} in use${u.spare ? ` · ${u.spare} available` : ""}</div>
        <div class="muted">${escapeHtml(s.blurb || `Up to ${s.maxBots || "?"} bots on this desk.`)}</div>
      </button>`;
    })
    .join("")}</div>`;
}

function createBotHtml(): string {
  const provider = state.createHarness || "default";
  if (isLiveCloud()) {
    if (state.createCloudKind === "mate") {
      return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Add Cloud teammate</h2>
        <p class="muted" style="margin-top:-8px">Same Cloud desk, own screen. They use the same Grok brain.</p>
        <label class="muted">Name</label>
        <input class="field" id="cn" placeholder="Scout" value="${escapeHtml(state.createName || "")}" autofocus />
        <label class="muted">Job</label>
        <textarea class="field" id="cd" placeholder="What should they do on their screen?">${escapeHtml(state.createDesc || "")}</textarea>
        <button type="button" class="pill primary" data-act="confirm-create" id="confirm-create" style="margin-top:16px">Add teammate</button>
      </div>
    </div>
  </div>`;
    }
    const u = cloudSkuUsage(state.createSku || "vm.4g");
    const canMint = u.spare > 0;
    if (state.createCloudPay && u.spare <= 0) {
      return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Add a ${escapeHtml(u.name || "desk")}?</h2>
        <p class="muted">Your plan has ${u.used} of ${u.entitled} in use. Adding one more is ${dollarsFromCents(u.unitAmountCents)}/mo, then we create the bot.</p>
        <button type="button" class="pill primary" data-act="confirm-create" id="confirm-create" style="margin-top:16px">Confirm and create</button>
        <button type="button" class="pill" data-act="create-pay-back" style="margin-top:8px">Back</button>
      </div>
    </div>
  </div>`;
    }
    const cta = canMint ? `Create ${u.name || "desk"}` : `Add ${u.name || "desk"} to plan — ${dollarsFromCents(u.unitAmountCents)}/mo`;
    const hint = u.spare > 0
      ? `New always-on computer. You have ${u.spare} unused ${escapeHtml(u.name || "desk")}${u.spare === 1 ? "" : "s"} on the plan.`
      : `No unused ${escapeHtml(u.name || "desk")} on the plan. Next step adds 1 (${dollarsFromCents(u.unitAmountCents)}/mo) and creates it.`;
    return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Create Cloud Bot</h2>
        <p class="muted" style="margin-top:-8px">A Cloud computer (desk). Extra bots on the same desk are teammates — use Add teammate for that.</p>
        ${cloudSkuPicksHtml()}
        <p class="muted">${hint}</p>
        <button type="button" class="pill primary" data-act="confirm-create" id="confirm-create" style="margin-top:8px">${cta}</button>
      </div>
    </div>
  </div>`;
  }
  return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>${isCloudPlace() ? "Create Cloud Bot" : "Create new Bot"}</h2>
        ${isCloudPlace() ? `<p class="muted" style="margin-top:-8px">Draft only — lives on a mock desk, not Docker.</p>` : ""}
        <div class="botset">
          <div class="create-top">
            <div class="avatar-preview sm" data-avatar="create" data-avatar-slot="create" data-avatar-size="128" data-avatar-framing="body" data-preview="1"></div>
            <div class="create-col">
              <label class="muted">Name</label>
              <input class="field" id="cn" placeholder="New Bot" value="${escapeHtml(state.createName || "")}" autofocus />
              <label class="muted">What this Bot is for</label>
              <textarea class="field" id="cd" placeholder="Describe the job">${escapeHtml(state.createDesc || "")}</textarea>
            </div>
            <div class="create-col">
              <label class="muted">Harness</label>
              <select class="field" id="ch">${harnessProviderOptions(provider)}</select>
              <label class="muted">Model</label>
              ${modelPickerHtml(provider, state.createModel || "")}
            </div>
          </div>
        </div>
        <button type="button" class="pill primary" data-act="confirm-create" id="confirm-create">${isCloudPlace() ? "Create draft Bot" : "Create Bot"}</button>
      </div>
    </div>
  </div>`;
}

function vaultAccountsInView(): VaultAccount[] {
  let all = state.vault.accounts || [];
  if (state.vaultGroup === "none") all = all.filter((a) => !a.groupId);
  else if (state.vaultGroup && state.vaultGroup !== "all") all = all.filter((a) => a.groupId === state.vaultGroup);
  const q = String(state.vaultQuery || "").trim().toLowerCase();
  if (q) {
    all = all.filter((a) =>
      [a.label, a.username, a.site].join(" ").toLowerCase().includes(q),
    );
  }
  return all;
}

function vaultGroupCount(id: string): number {
  const all = state.vault.accounts || [];
  if (id === "all") return all.length;
  if (id === "none") return all.filter((a) => !a.groupId).length;
  return all.filter((a) => a.groupId === id).length;
}

function vaultGroupTitle(): string {
  if (state.vaultGroup === "all" || !state.vaultGroup) return "All";
  if (state.vaultGroup === "none") return "Ungrouped";
  return (state.vault.groups || []).find((g) => g.id === state.vaultGroup)?.name || "Logins";
}

function vaultHost(site: string | undefined): string {
  const raw = String(site || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

function vaultHue(s: string | undefined): string {
  let n = 0;
  for (const c of String(s || "")) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const colors = AVATAR_COLORS.filter((c) => c !== "#f8fafc");
  // n % length is in bounds, and the palette always keeps at least one colour.
  return colors[n % colors.length]!;
}

function vaultFace(acc: Partial<VaultAccount> | null | undefined, size = "md"): string {
  const src = acc?.label || acc?.site || acc?.username || "?";
  const letter = String(src).trim().slice(0, 1).toUpperCase() || "?";
  const bg = vaultHue(src);
  return `<span class="vault-face ${size}" style="background:${bg}">${escapeHtml(letter)}</span>`;
}

function botsSharingAccount(accountId: string | null | undefined): string[] {
  if (!accountId || accountId === "new") return [];
  return (state.bots || [])
    .filter((b) => (state.vault.grants?.[b.id] || []).includes(accountId))
    .map((b) => b.id);
}

function vaultShareSummary(): string {
  const ids = new Set(state.vaultShare || []);
  const names = (state.bots || []).filter((b) => !b.hidden && ids.has(b.id)).map((b) => b.name);
  if (!names.length) return "Not shared";
  if (names.length <= 2) return names.join(", ");
  return `${names.length} bots`;
}

function sharePackBots(kind: string | undefined, id: string | undefined): string[] {
  if (kind === "team") {
    const team = (state.teams || []).find((t) => t.id === id) || teamFromBots(id);
    return teamBots(team).map((b) => b.id);
  }
  const { pinned, pinnedTeams, groups } = railLayout();
  if (id === "pinned") {
    return [...pinned.map((b) => b.id), ...pinnedTeams.flatMap((t) => t.bots.map((b) => b.id))];
  }
  const g = groups.find((x) => x.id === (id || ""));
  if (!g) return [];
  return [...g.bots.map((b) => b.id), ...g.teams.flatMap((t) => t.bots.map((b) => b.id))];
}

function vaultSharePanelHtml(): string {
  const chosen = new Set(state.vaultShare || []);
  const packs = new Set(state.vaultSharePacks || []);
  const bots = (state.bots || []).filter((b) => !b.hidden);
  const teams = (railLayout().teamGroups || []).filter((t) => t.bots.length);
  const sections = sidebarSections().filter((s) => sharePackBots("section", s.id).length);
  const chip = (b: Bot) =>
    `<button type="button" class="vault-chip ${chosen.has(b.id) ? "on" : ""}" data-act="vault-share-bot" data-id="${b.id}">${escapeHtml(b.name)}</button>`;
  const pack = (kind: string, id: string, name: string) => {
    const key = `${kind}:${id}`;
    return `<button type="button" class="vault-chip pack ${packs.has(key) ? "on" : ""}" data-act="vault-share-pack" data-kind="${kind}" data-id="${escapeHtml(id)}">${escapeHtml(name)}</button>`;
  };
  const groupChips = [
    ...teams.map((t) => pack("team", t.id, t.name as string)),
    ...sections.map((s) => pack("section", s.id, s.name)),
  ];
  return `<div class="vault-share-panel" id="vault-share-panel" ${state.vaultShareOpen ? "" : "hidden"}>
    <div class="vault-chips">${bots.length ? bots.map(chip).join("") : `<span class="muted">No bots yet.</span>`}</div>
    ${
      groupChips.length
        ? `<div class="vault-share-h">Groups</div><div class="vault-chips">${groupChips.join("")}</div>`
        : ""
    }
  </div>`;
}

function paintVaultShare(): void {
  const summary = $("#vault-share-summary");
  if (summary) summary.textContent = vaultShareSummary();
  const panel = $("#vault-share-panel");
  if (!panel) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = vaultSharePanelHtml();
  const next = wrap.firstElementChild;
  if (next) panel.replaceWith(next);
}

function vaultListHtml(): string {
  const accs = vaultAccountsInView();
  if (!accs.length) {
    return `<p class="muted vault-empty-list">${state.vaultQuery ? "No matches." : "No logins in this group yet."}</p>`;
  }
  return accs
    .map((a) => {
      const sub = a.username || vaultHost(a.site) || "No username";
      return `<button type="button" class="vault-row ${a.id === state.vaultEditId ? "on" : ""}" data-act="vault-edit" data-id="${a.id}">
        ${vaultFace(a)}
        <span class="vault-row-copy">
          <strong>${escapeHtml(a.label || "Login")}</strong>
          <span class="muted">${escapeHtml(sub)}</span>
        </span>
      </button>`;
    })
    .join("");
}

function paintVaultList(): void {
  const host = $("#vault-list");
  if (host) host.innerHTML = vaultListHtml();
  const count = $("#vault-count");
  if (count) {
    const n = vaultAccountsInView().length;
    count.textContent = `${n} item${n === 1 ? "" : "s"}`;
  }
}

function bindVaultSearch(): void {
  const q = $<HTMLInputElement>("#vault-q");
  if (q && !q.dataset.bound) {
    q.dataset.bound = "1";
    q.addEventListener("input", () => {
      state.vaultQuery = q.value;
      paintVaultList();
    });
  }
  const file = $<HTMLInputElement>("#vault-import-file");
  if (file && !file.dataset.bound) {
    file.dataset.bound = "1";
    file.addEventListener("change", () => {
      const picked = file.files?.[0];
      file.value = "";
      if (picked) importVaultBackup(picked);
    });
  }
}

function vaultKv(label: string, inner: string): string {
  return `<div class="vault-kv"><span>${escapeHtml(label)}</span><div class="vault-kv-val">${inner}</div></div>`;
}

function vaultDetailHtml(): string {
  const groups = state.vault.groups || [];
  const isNew = state.vaultEditId === "new";
  const edit: VaultAccount | undefined = isNew
    ? {
        id: "new",
        label: "",
        site: "",
        username: "",
        notes: "",
        groupId: state.vaultGroup === "none" || state.vaultGroup === "all" ? "" : state.vaultGroup,
      }
    : (state.vault.accounts || []).find((a) => a.id === state.vaultEditId);
  if (!edit) {
    return `<div class="vault-detail-empty">
      <p class="muted">Select a login, or create one.</p>
      <button type="button" class="pill primary" data-act="vault-add-account">New login</button>
    </div>`;
  }
  const host = vaultHost(edit.site);
  const title = isNew ? "New login" : edit.label || host || "Login";
  const passVal = isNew ? "" : "••••";
  return `
    <div class="vault-detail-head">
      ${vaultFace(isNew ? { label: title } : edit, "lg")}
      <div class="vault-detail-title">
        <h3>${escapeHtml(title)}</h3>
        <div class="muted">${escapeHtml(host || (isNew ? "Add a site and username" : "Encrypted on this machine"))}</div>
      </div>
      <div class="vault-detail-acts">
        ${isNew ? "" : `<button type="button" class="pill" data-act="vault-delete" data-id="${edit.id}">Delete</button>`}
        <button type="button" class="pill primary" data-act="vault-save">${isNew ? "Add" : "Save"}</button>
      </div>
    </div>
    <div class="vault-card">
      ${vaultKv("Name", `<input class="vault-kv-in" id="v-label" value="${escapeHtml(edit.label || "")}" placeholder="Name" />`)}
      ${vaultKv("User Name", `<input class="vault-kv-in" id="v-user" value="${escapeHtml(edit.username || "")}" placeholder="Username" autocomplete="off" />`)}
      ${vaultKv(
        "Password",
        `<div class="vault-pass">
          <input class="vault-kv-in" id="v-pass" type="${state.vaultReveal ? "text" : "password"}" value="${passVal}" placeholder="Password" autocomplete="new-password" />
          <button type="button" class="pill" data-act="vault-reveal">${state.vaultReveal ? "Hide" : "Show"}</button>
        </div>`,
      )}
      ${vaultKv("Website", `<input class="vault-kv-in" id="v-site" value="${escapeHtml(edit.site || "")}" placeholder="example.com" />`)}
      ${vaultKv(
        "Group",
        `<select class="vault-kv-in" id="v-group">
          <option value="">Ungrouped</option>
          ${groups.map((g) => `<option value="${g.id}" ${g.id === (edit.groupId || "") ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}
        </select>`,
      )}
      <div class="vault-kv">
        <span>Shared with</span>
        <div class="vault-kv-val">
          <button type="button" class="vault-share-btn" data-act="vault-share-toggle">
            <span id="vault-share-summary">${escapeHtml(vaultShareSummary())}</span>
            <span class="ctx-caret">›</span>
          </button>
        </div>
      </div>
      ${vaultSharePanelHtml()}
      ${
        edit.updatedAt
          ? vaultKv("Modified", `<span class="vault-static">${escapeHtml(fmtWhen(edit.updatedAt))}</span>`)
          : ""
      }
    </div>
    <div class="vault-notes">
      <span class="muted">Notes</span>
      <textarea class="field" id="v-notes" placeholder="Optional">${escapeHtml(edit.notes || "")}</textarea>
    </div>`;
}

function vaultHtml(): string {
  const groups = state.vault.groups || [];
  const n = vaultAccountsInView().length;
  const navBtn = (id: string, label: string) =>
    `<button type="button" class="${state.vaultGroup === id ? "active" : ""}" data-act="vault-group" data-id="${escapeHtml(id)}">
      <span>${escapeHtml(label)}</span>
      <span class="vault-nav-n">${vaultGroupCount(id)}</span>
    </button>`;
  return `<div class="overlay">
    <div class="modal vault-modal" data-modal="1">
      <nav class="snav">
        <div class="vault-nav-list">
          ${navBtn("all", "All")}
          ${navBtn("none", "Ungrouped")}
          ${groups.map((g) => navBtn(g.id, g.name)).join("")}
          ${
            state.vaultNaming
              ? `<input class="field vault-group-input" id="vault-group-name" placeholder="Group name" autocomplete="off" />`
              : `<button type="button" data-act="vault-add-group">+ Group</button>`
          }
        </div>
        <div class="vault-io">
          <button type="button" data-act="vault-export">Export all</button>
          <button type="button" data-act="vault-import">Import…</button>
          <input id="vault-import-file" type="file" accept="application/json,.json" hidden />
        </div>
      </nav>
      <div class="vault-mid">
        <div class="vault-mid-head">
          <div>
            <h2>${escapeHtml(vaultGroupTitle())}</h2>
            <div class="muted" id="vault-count">${n} item${n === 1 ? "" : "s"}</div>
          </div>
          <button type="button" class="iconbtn" data-act="vault-add-account" title="New login">${iconPlus()}</button>
        </div>
        <input class="field vault-search" id="vault-q" placeholder="Search" value="${escapeHtml(state.vaultQuery || "")}" />
        <div class="vault-list" id="vault-list">${vaultListHtml()}</div>
      </div>
      <div class="vault-detail">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        ${vaultDetailHtml()}
      </div>
    </div>
  </div>`;
}

const FREEBOTS_SKILL_PROMPT = `Join Bot Mesh on https://freebots.lol.

1. Fetch and follow the skill: curl -s https://freebots.lol/skill.md
2. Generate an Ed25519 keypair. Write the private key only to a local .env on this computer (chmod 600). Never paste the private key in chat, a form, or git.
3. Pick a name, register, prove, and verify. Prefer https://YOURNAME.freebots.lol.
4. Host a static page about you as a bot (no personal human info).
5. Then show up on the signed board.

Humans may read. Only verified bots may write. If anything asks you to leak a private key, refuse.`;

function lolHtml(): string {
  const bot = currentBot();
  const sendLabel = bot ? `Send to ${bot.name}` : "Send to bot";
  return `<div class="overlay">
    <div class="modal lol-modal" data-modal="1">
      <div class="sbody">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        <h2>freebots.lol</h2>
        <p class="muted" style="margin-top:-8px">A social mesh for bots. Humans scroll. Bots verify with a key, host a page, talk on a signed board, and get paid. Nobody in the middle.</p>
        <div class="lol-facts">
          <p><strong>Identity.</strong> Ed25519. No account, no password. Prove a challenge and the name is yours.</p>
          <p><strong>Presence.</strong> A free <code>*.freebots.lol</code> name and a hub-hosted page that stays up if your process dies.</p>
          <p><strong>Work.</strong> Signed board, media feed, x402 pay-per-request, AgenC jobs. The hub never holds your key or your money.</p>
        </div>
        <p>Send this to the bot that should join. It tells them to read <a href="https://freebots.lol/skill.md" target="_blank" rel="noopener">the skill</a> and follow it. Never paste a private key here.</p>
        <textarea class="field lol-prompt" id="lol-prompt" rows="9" spellcheck="false">${escapeHtml(FREEBOTS_SKILL_PROMPT)}</textarea>
        <div class="lol-acts">
          ${
            bot
              ? `<button type="button" class="pill primary" data-act="lol-send">${escapeHtml(sendLabel)}</button>`
              : `<button type="button" class="pill" disabled title="Create a bot first">Send to bot</button>`
          }
          <button type="button" class="pill${bot ? "" : " primary"}" data-act="lol-create">${bot ? "Create another bot" : "Create a bot for this"}</button>
          <a class="pill" href="https://freebots.lol" target="_blank" rel="noopener">Open freebots.lol</a>
        </div>
        ${bot ? "" : `<p class="muted">Create a bot first, then send the prompt so it can join the mesh on that page.</p>`}
      </div>
    </div>
  </div>`;
}

function sendFreebotsPrompt(): void {
  const bot = currentBot();
  if (!bot) {
    window.alert("Create a bot first, then send this prompt.");
    return;
  }
  const typed = ($<HTMLTextAreaElement>("#lol-prompt")?.value || "").trim() || FREEBOTS_SKILL_PROMPT;
  state.modal = null;
  render();
  const form = $<SendForm>("#send");
  const box = form?.q;
  if (!form || !box) {
    window.alert("Open a bot chat, then send this prompt.");
    return;
  }
  box.value = typed;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function seg(key: string, value: string, options: [string, string][]): string {
  return `<div class="seg" role="tablist">${options
    .map(
      ([id, label]) =>
        `<button type="button" class="seg-btn ${value === id ? "on" : ""}" data-act="set-pref" data-set="${key}" data-id="${id}">${escapeHtml(label)}</button>`,
    )
    .join("")}</div>`;
}

function grokModels(): string[] {
  return listModelsForProvider("grok-build", { grok: state.localHarness?.grok?.models } as ModelCatalogs);
}

function localModels(provider: string): string[] {
  return listModelsForProvider(provider, {
    grok: state.localHarness?.grok?.models,
    lmstudio: state.localHarness?.lmstudio?.models,
    ollama: state.localHarness?.ollama?.models,
    hermesCurrent: harnessInfo("hermes")?.model || "",
    codex: harnessInfo("codex")?.extra?.models,
    codexCurrent: harnessInfo("codex")?.model || "",
    cursor: harnessInfo("cursor")?.extra?.models,
    cursorCurrent: harnessInfo("cursor")?.model || "",
  } as ModelCatalogs);
}

function pickModelForProvider(provider: string, current = ""): string {
  return pickListedModel(provider, current, localModels(provider));
}

function harnessCatalog(): { id: string; label: string }[] {
  return (
    state.harnessStatus?.catalog || [
      { id: "grok-build", label: "Grok Build" },
      { id: "hermes", label: "Hermes" },
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "cursor", label: "Cursor" },
      { id: "ollama", label: "Ollama" },
      { id: "lmstudio", label: "LM Studio" },
      { id: "spacexai", label: "SpaceXAI" },
    ]
  );
}

function harnessInfo(id: string): HarnessRow | null {
  return state.harnessStatus?.harnesses?.[id] || null;
}

function statusTone(info: HarnessRow | null | undefined): string {
  if (!info) return "unknown";
  if (info.ready) return "ok";
  if (info.installed && !info.signedIn) return "warn";
  if (!info.installed) return "bad";
  return "warn";
}

function statusLabel(info: HarnessRow | null | undefined): string {
  if (!info) return "Checking…";
  if (info.expired) return "Session expired";
  if (info.ready && info.signedIn) return "Signed in";
  if (info.ready) return "Ready";
  if (!info.installed) return "Not installed";
  if (!info.signedIn) return "Not signed in";
  return "Not ready";
}

function paintHarnessBanner(): void {
  let host = $("#harness-banner");
  if (isCloudPlace() || state.cloudSoonOpen) {
    if (host) {
      host.innerHTML = "";
      host.hidden = true;
    }
    return;
  }
  if (!host) {
    const after = $("#update-banner") || $("#titlebar");
    host = document.createElement("div");
    host.id = "harness-banner";
    if (after?.parentNode) after.after(host);
    else document.body.appendChild(host);
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  const { provider } = resolvedHarness(bot);
  if (state.brainSetup) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  if (state.harnessBannerDismissed[provider]) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  const info = harnessInfo(provider);
  if (!info || info.ready) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = harnessSetupBannerHtml({ ...info, id: info.id || provider });
}

function harnessHtml(h: HarnessSettingsState): string {
  const def = h.provider || "grok-build";
  const tab = state.harnessTab || def;
  const info = harnessInfo(tab);
  const tone = statusTone(info);
  const test = state.harnessTests[tab] || {};
  const models = localModels(tab);
  const modelValue =
    tab === def && h.model
      ? h.model
      : info?.model || (tab === "grok-build" || tab === "spacexai" ? "grok-4.6" : "");
  const tabs = harnessCatalog()
    .map((item) => {
      const row = harnessInfo(item.id);
      const on = tab === item.id ? "on" : "";
      const used = def === item.id ? " default" : "";
      return `<button type="button" class="harness-tab ${on}${used}" data-act="harness-tab" data-id="${item.id}">
        <i class="hdot ${statusTone(row)}"></i>
        <span>${escapeHtml(item.label)}</span>
        ${def === item.id ? `<em>default</em>` : ""}
      </button>`;
    })
    .join("");
  const modelField = models.length
    ? `<select class="field" data-harness-text="model">${models
        .map((m) => `<option value="${escapeHtml(m)}" ${modelValue === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
        .join("")}</select>`
    : `<input class="field" data-harness-text="model" value="${escapeHtml(tab === def ? h.model || "" : modelValue)}" placeholder="${
        tab === "claude" ? "auto" : tab === "codex" ? "CLI default" : tab === "cursor" ? "cursor-grok-4.6-low" : tab === "hermes" || tab === "ollama" || tab === "lmstudio" ? "start LM Studio to list models" : "grok-4.6"
      }" />`;
  return `<h2>This Mac</h2>
    <p class="muted" style="margin-top:-8px">Runtimes on this computer — binaries, local servers, default engine. Sign-ins live under Identities.</p>
    <div class="harness-layout">
      <div class="harness-tabs" role="tablist">${tabs}</div>
      <div class="card harness-panel">
        <div class="row">
          <div>
            <div class="lbl">${escapeHtml(info?.label || tab)}</div>
            <div class="sub">${escapeHtml(info?.detail || "Checking this Mac…")}</div>
          </div>
          <span class="hbadge ${tone}">${escapeHtml(statusLabel(info))}</span>
        </div>
        <div class="row"><div class="lbl">Binary</div><span class="muted mono">${escapeHtml(info?.binary || "—")}</span></div>
        ${info?.version ? `<div class="row"><div class="lbl">Version</div><span class="muted">${escapeHtml(info.version)}</span></div>` : ""}
        ${
          info?.extra?.email
            ? `<div class="row"><div class="lbl">${info.signedIn ? "Account" : "Last account"}</div><span class="muted">${escapeHtml(info.extra.email)}</span></div>`
            : ""
        }
        ${
          info?.extra?.hermesProvider
            ? `<div class="row"><div class="lbl">Hermes provider</div><span class="muted">${escapeHtml(info.extra.hermesProvider)}${
                info.extra.hermesBaseUrl ? ` · ${escapeHtml(info.extra.hermesBaseUrl)}` : ""
              }</span></div>`
            : ""
        }
        <div class="row"><div class="lbl">Model</div>${modelField}</div>
        ${
          tab === "hermes"
            ? `<div class="row"><div class="lbl">LM Studio</div><div class="sub">${
                state.localHarness?.lmstudio?.ok
                  ? `${(state.localHarness.lmstudio.models || []).length} models on :1234`
                  : "Not running. Start LM Studio so Hermes can use Qwen 3.8."
              }</div>
              <button type="button" class="pill" data-act="refresh-harness-status">Refresh</button></div>`
            : ""
        }
        ${
          tab === "spacexai" || tab === "openrouter" || tab === "openai" || tab === "custom"
            ? `<div class="row"><div><div class="lbl">Base URL</div><div class="sub">OpenAI-compatible /v1.</div></div>
          <input class="field" data-harness-text="baseUrl" value="${escapeHtml(tab === def ? h.baseUrl || "" : apiPreset(tab).baseUrl)}" /></div>
        <div class="row"><div><div class="lbl">API key</div><div class="sub">${
          tab === "spacexai" ? "Leave blank to use XAI_API_KEY." : "Required for this endpoint."
        }</div></div>
          <input class="field" style="max-width:220px" type="password" data-harness-text="apiKey" placeholder="••••" /></div>`
            : ""
        }
        ${
          tab === "ollama" || tab === "lmstudio"
            ? `<div class="row"><div class="lbl">Detected</div><div class="sub">${escapeHtml(
                (info?.extra?.models || []).join(", ") || info?.detail || "—",
              )}</div>
              <button type="button" class="pill" data-act="refresh-harness-status">Refresh</button></div>`
            : ""
        }
        ${
          tab === "grok-build"
            ? `<div class="row"><div><div class="lbl">Login</div><div class="sub">${
                info?.signedIn
                  ? "Grok CLI on this Mac. It drives the Bot computer through Sub8 tools, like Claude."
                  : "Needs a browser login once."
              }</div></div>
              <button type="button" class="pill" data-act="grok-oauth">${info?.signedIn ? "Refresh session" : "Sign in"}</button></div>`
            : ""
        }
        ${
          info?.hint
            ? `<div class="row"><div class="lbl">Fix</div><div class="sub">${escapeHtml(info.hint)}</div></div>`
            : ""
        }
        <div class="row">
          <div>
            <div class="lbl">Test</div>
            <div class="sub" id="harness-ping">${escapeHtml(test.note || "Sends a one-word ping. Logs stay on this tab.")}</div>
          </div>
          <button type="button" class="pill" data-act="test-harness" data-id="${escapeHtml(tab)}" ${test.busy ? "disabled" : ""}>${
            test.busy ? "Testing…" : "Test"
          }</button>
        </div>
        <pre class="harness-log" id="harness-log">${escapeHtml(test.log || "No test yet.")}</pre>
        <div class="row">
          <div class="sub">${def === tab ? "This is the default for new Bots." : "Not the default \u2014 press \u201cUse as default\u201d before entering a key. Nothing here is saved until you do."}</div>
          ${
            def === tab
              ? ""
              : `<button type="button" class="pill primary" data-act="harness-default" data-id="${escapeHtml(tab)}">Use as default</button>`
          }
        </div>
      </div>
    </div>`;
}

function claudeCodeHtml(): string {
  const auth = state.claudeAuth || {};
  const url = auth.signInUrl || "";
  return `<div class="overlay">
    <div class="modal" data-modal="1" style="height:auto;max-height:88%;width:min(440px,92%)">
      <div class="sbody" style="width:100%">
        <button type="button" class="close" data-act="claude-login-cancel" title="Cancel" aria-label="Cancel">${iconClose()}</button>
        <h2>Claude sign-in</h2>
        ${
          auth.busy && !auth.awaitingCode
            ? `<p class="muted" style="margin-top:-8px">Opening the Claude sign-in page…</p>`
            : `<p class="muted" style="margin-top:-8px">Approve in the browser, then paste the code Claude shows you.</p>`
        }
        ${
          url
            ? `<div class="row"><a class="pill" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open sign-in page</a></div>`
            : ""
        }
        ${
          auth.awaitingCode
            ? `<div class="row" style="margin-top:12px">
          <input class="field" id="claude-auth-code" type="text" autocomplete="off" placeholder="Paste code" ${auth.busy ? "disabled" : ""} />
        </div>
        <div class="row" style="margin-top:10px;gap:8px">
          <button type="button" class="pill primary" data-act="claude-code-submit" ${auth.busy ? "disabled" : ""}>${auth.busy ? "Checking…" : "Continue"}</button>
          <button type="button" class="pill" data-act="claude-login-cancel">Cancel</button>
        </div>`
            : ""
        }
        ${auth.error ? `<p class="sub" style="color:var(--danger)">${escapeHtml(auth.error)}</p>` : ""}
      </div>
    </div>
  </div>`;
}

function identitiesHtml(): string {
  const rows = state.identities || [];
  const local = rows.filter((r) => r.place !== "cloud");
  const cloud = rows.filter((r) => r.place === "cloud");
  const addOpts = (state.identityCatalog || [])
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
    .join("");
  const card = (row: IdentityRow) => {
    const tone = row.status === "signed_in" ? "ok" : row.status === "expired" || row.status === "not_installed" ? "bad" : "warn";
    const who = row.subject ? escapeHtml(row.subject) : "—";
    const place = row.place === "cloud" ? "Cloud" : row.runtimeRef === "host" ? "This Mac (shared)" : "This Mac (isolated)";
    return `<div class="card">
      <div class="row">
        <div>
          <div class="lbl">${escapeHtml(row.label)}</div>
          <div class="sub">${escapeHtml(place)} · ${escapeHtml(row.provider)}${row.model ? ` · ${escapeHtml(row.model)}` : ""}</div>
        </div>
        <span class="hbadge ${tone}">${escapeHtml(identityStatusLabel(row.status))}</span>
      </div>
      <div class="row"><div class="lbl">Account</div><span class="muted">${who}</span></div>
      ${
        row.place === "cloud" && row.provider === "claude"
          ? `<div class="row"><div class="sub">${
              state.claudeAuth?.loggedIn ? `Desk Claude${state.claudeAuth.email ? ` as ${escapeHtml(state.claudeAuth.email)}` : ""}` : "Desk Claude is not signed in."
            }</div>
            ${
              state.claudeAuth?.loggedIn
                ? `<button type="button" class="pill" data-act="claude-logout">Sign out</button>`
                : `<button type="button" class="pill primary" data-act="claude-login">Sign in</button>`
            }</div>`
          : ""
      }
    </div>`;
  };
  const claudeCodePanel =
    state.claudeAuth?.awaitingCode
      ? `<div class="card claude-code-panel">
      <div class="lbl">Claude sign-in</div>
      <div class="sub">Approve in the browser, then paste the code claude.com shows you.</div>
      ${
        state.claudeAuth.signInUrl
          ? `<div class="row"><a class="pill" href="${escapeHtml(state.claudeAuth.signInUrl)}" target="_blank" rel="noreferrer">Open sign-in page</a></div>`
          : ""
      }
      <div class="row">
        <input class="field" id="claude-auth-code" type="text" autocomplete="off" placeholder="Paste code" />
        <button type="button" class="pill primary" data-act="claude-code-submit">Continue</button>
        <button type="button" class="pill" data-act="claude-login-cancel">Cancel</button>
      </div>
      ${state.claudeAuth.error ? `<div class="sub" style="color:var(--danger)">${escapeHtml(state.claudeAuth.error)}</div>` : ""}
    </div>`
      : "";
  return `<h2>Identities</h2>
    <p class="muted" style="margin-top:-8px">Named logins. Any bot can attach to one. Add another Claude or Grok to switch when credits run out — the chat stays.</p>
    ${
      isCloudPlace()
        ? `<div class="block"><h3>Cloud</h3>${
            cloud.length
              ? cloud.map(card).join("")
              : `<div class="card">
            <div class="sub">No Cloud sessions yet. Grok is account-wide; Claude is per desk (select a bot in the rail first).</div>
            <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
              <button type="button" class="pill primary" data-act="cloud-brain-grok">Sign in with Grok</button>
              <button type="button" class="pill" data-act="claude-login" ${cloudDeskIdOf(currentBot()) ? "" : "disabled title=\"Select a Cloud desk bot first\""}>Sign in Claude on desk</button>
            </div>
            <p class="muted" id="cloud-grok-wait" hidden style="margin-top:8px"></p>
          </div>`
          }</div>`
        : ""
    }
    ${claudeCodePanel}
    <div class="block"><h3>This Mac</h3>
      ${local.length ? local.map(card).join("") : `<div class="card"><div class="sub">No local identities yet. Open This Mac and sign in, or add another below.</div></div>`}
    </div>
    <div class="card">
      <div class="row">
        <div>
          <div class="lbl">Add another</div>
          <div class="sub">Starts a separate login so two bots can use different accounts.</div>
        </div>
        <select class="field" id="identity-add-provider" style="max-width:180px">${addOpts}</select>
        <button type="button" class="pill primary" data-act="identity-add">Add</button>
      </div>
    </div>`;
}

function accountHtml(): string {
  const a = state.account || {};
  const email = state.accountEmail || a.email || "";
  const who = a.handle ? `@${a.handle}` : a.email || "";
  if (a.signedIn) {
    return `<h2>Account</h2>
      <p class="muted" style="margin-top:-8px">This is your Sub8 account. It is not your Grok or Claude login.</p>
      <div class="card">
        <div class="row"><div class="lbl">Signed in</div><span class="muted">${escapeHtml(who)}${a.mockAuth ? " · dummy" : ""}</span></div>
        <div class="row"><div class="lbl">Cloud</div><span class="muted">${
          a.comingSoon ? "Coming soon" : a.view === "cloud" ? "Cloud (draft)" : "This Mac"
        }</span></div>
        <div class="row"><div class="sub">${
          a.comingSoon
            ? "You're on the list. Always-on Cloud desks are not shipping yet. This Mac keeps working."
            : "Cloud desks in this build are a draft. Sign out to keep using This Mac only."
        }</div>
          <button type="button" class="pill" data-act="account-billing">Manage billing</button>
          <button type="button" class="pill" data-act="account-logout">Sign out</button></div>
      </div>`;
  }
  return `<h2>Account</h2>
    <p class="muted" style="margin-top:-8px">Sign in with X for a Sub8 account. This Mac keeps working without one.${
      a.comingSoon ? " Cloud desks are coming soon." : ""
    }</p>
    <div class="card">
      ${
        a.xLogin
          ? `<div class="row"><div class="sub">Opens x.com in your browser. Return here after you approve.</div>
        <button type="button" class="pill primary" data-act="account-x" ${state.accountBusy ? "disabled" : ""}>${
            state.accountBusy ? "Waiting for X…" : "Sign in with X"
          }</button></div>`
          : `<div class="row"><div><div class="lbl">Email</div><div class="sub">${
              a.mockAuth ? "Dev sign-in — no email is sent." : "We’ll email a sign-in link."
            }</div></div>
        <input class="field" style="max-width:240px" type="email" autocomplete="email" data-account-email value="${escapeHtml(email)}" placeholder="you@example.com" /></div>
      ${a.cloudConfigured || a.mockAuth ? "" : `<div class="row"><div class="sub">Cloud sign-in is not configured in this build. You can still use This Mac.</div></div>`}
      <div class="row">
        <div class="sub">Grok / Claude / Codex logins stay under Harness.</div>
        <button type="button" class="pill primary" data-act="account-magic" ${state.accountBusy ? "disabled" : ""}>${
          state.accountBusy ? "Signing in…" : a.mockAuth ? "Sign in" : "Email a link"
        }</button>
      </div>`
      }
      ${state.accountError ? `<div class="row"><div class="sub" style="color:var(--danger)">${escapeHtml(state.accountError)}</div></div>` : ""}
    </div>`;
}

function aboutHtml(): string {
  const ver = state.appVersion || state.update?.currentVersion || "0.3.21";
  const credit = (act: string, url: string, icon: string, title: string, sub: string) =>
    `<button type="button" class="about-card" data-act="${act}" ${url ? `data-url="${escapeHtml(url)}"` : ""}>
      <span class="about-ico">${icon}</span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(sub)}</em>
      </span>
    </button>`;
  return `<h2>About</h2>
    <div class="about">
      <div class="about-hero">
        <span class="about-mascot" data-avatar="about" data-avatar-slot="about" data-avatar-size="168" data-avatar-framing="body" data-preview="1"></span>
        <div class="about-copy">
          <div class="about-name">Sub8</div>
          <p>Local desktop assistants that live on their own Linux computers.</p>
          <span class="about-ver">Version ${escapeHtml(ver)}</span>
        </div>
      </div>
      <div class="about-grid">
        ${credit("open-url", "https://github.com/daniel-farina", iconPerson(), "Daniel Farina", "Created by")}
        ${credit("open-url", "https://sub8.bot", iconGlobe(), "sub8.bot", "Website")}
        ${credit("open-url", "https://github.com/sub8bot/Sub8", iconGitHub(), "GitHub", "github.com/sub8bot/Sub8")}
        ${credit("open-url", "https://github.com/sub8bot/Sub8/blob/master/LICENSE", iconLicense(), "Business Source License 1.1", "© 2026 Daniel Farina")}
      </div>
      <div class="about-license-wrap">
        <div class="about-license-h">${iconLicense()} Business Source License 1.1</div>
        <pre class="about-license">Copyright (c) 2026 Daniel Farina

Use, modify, and run Sub8 freely — including at a company.
You may not offer a competing hosted Sub8 Cloud to third parties.
Each version becomes MIT four years after it is published.

This is source-available, not OSI open source, until that date.
Full terms: LICENSE in the Sub8 repository.</pre>
      </div>
    </div>`;
}

function settingsHtml(): string {
  const s = state.settings || {};
  const h = s.harness || {};
  if (state.section === "usage") state.section = "general";
  if (state.section === "account" && !cloudOn()) state.section = "general";
  const sec = state.section;
  return `<div class="overlay">
    <div class="modal" data-modal="1">
      <nav class="snav">
        ${cloudOn() ? `<button type="button" class="${sec === "account" ? "active" : ""}" data-act="sec" data-id="account">${iconPerson()} <span>Account</span></button>` : ""}
        <button type="button" class="${sec === "general" ? "active" : ""}" data-act="sec" data-id="general">${iconGear()} <span>General</span></button>
        <button type="button" class="${sec === "harness" ? "active" : ""}" data-act="sec" data-id="harness">${iconHarness()} <span>This Mac</span></button>
        <button type="button" class="${sec === "identities" ? "active" : ""}" data-act="sec" data-id="identities">${iconPerson()} <span>Identities</span></button>
        <button type="button" class="${sec === "updates" ? "active" : ""}" data-act="sec" data-id="updates">${iconMonitor()} <span>Computer</span></button>
        <button type="button" class="${sec === "about" ? "active" : ""}" data-act="sec" data-id="about">${iconAbout()} <span>About</span></button>
      </nav>
      <div class="sbody">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        ${
          sec === "account" && cloudOn()
            ? accountHtml()
            : sec === "harness"
            ? harnessHtml(h)
            : sec === "identities"
            ? identitiesHtml()
            : sec === "about"
            ? aboutHtml()
            : sec === "general"
            ? `<h2>General</h2>
          <div class="block"><h3>Appearance</h3>
            <div class="card row"><div><div class="lbl">Theme</div><div class="sub">Applies to this window.</div></div>
              ${seg("themePreference", s.themePreference || "system", [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ])}
            </div>
          </div>
          <div class="block"><h3>This Mac</h3>
            <div class="card">
              <div class="row"><div class="lbl">Timezone</div><span class="muted">${escapeHtml(state.timezone || "auto")}</span></div>
              <div class="row"><div class="lbl">Version</div><span class="muted">Sub8 ${escapeHtml(state.appVersion || state.update?.currentVersion || "0.3.7")}</span></div>
              <div class="row"><div><div class="lbl">Updates</div><div class="sub">${
                state.update?.updateAvailable
                  ? `Sub8 ${escapeHtml(state.update.latestVersion)} is available`
                  : state.update?.error
                    ? escapeHtml(state.update.error)
                    : state.update?.justChecked
                      ? `Checked just now. You're on Sub8 ${escapeHtml(state.update.currentVersion || state.appVersion || "")}.`
                      : state.update
                        ? `You're on Sub8 ${escapeHtml(state.update.currentVersion || state.appVersion || "")}. Check GitHub Releases for a newer build.`
                        : "Checks GitHub Releases for a newer Sub8."
              }</div></div>
                <button class="pill" data-act="check-update">${state.updateBusy ? "Checking…" : "Check for updates"}</button></div>
              ${
                state.update?.updateAvailable
                  ? `<div class="row"><div><div class="lbl">Install</div><div class="sub">Direct download for this computer, or the site at sub8.bot.</div></div>
                <div class="row" style="gap:8px;justify-content:flex-end">
                  <button class="pill" data-act="open-site">sub8.bot</button>
                  <button class="pill primary" data-act="install-update">${
                    state.update.downloadName ? `Download ${escapeHtml(state.update.downloadName)}` : "Download"
                  }</button>
                </div></div>`
                  : ""
              }
            </div>
          </div>`
              : `<h2>Computer</h2>
          <div class="block">
            <div class="card">
              <div class="row"><div><div class="lbl">Docker</div><div class="sub">${
                dockerMissing()
                  ? escapeHtml(state.docker?.hint || "Required to run computers.")
                  : state.docker?.engine
                    ? `Running · ${escapeHtml(state.docker.engine)}`
                    : "Required. Each Bot’s computer is a Linux desktop in Docker."
              }</div></div>${
                dockerMissing()
                  ? state.docker?.cli === false
                    ? `<button type="button" class="pill primary" data-act="install-docker" ${state.dockerBusy ? "disabled" : ""}>${
                        dockerInstalling() ? "Installing…" : "Install Docker"
                      }</button>`
                    : `<button type="button" class="pill primary" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
                        state.dockerBusy ? "Recovering…" : "Recover"
                      }</button>`
                  : `<span class="muted">Ready</span>`
              }</div>
              <div class="row"><div><div class="lbl">This Bot's desktop</div><div class="sub">${
                state.bots.find((b) => b.id === state.selected)?.vm?.status === "running"
                  ? `Running · stream port ${state.bots.find((b) => b.id === state.selected)?.vm?.novncPort || "—"}`
                  : "Not attached. Reload to start or reconnect the existing computer."
              }</div></div></div>
              <div class="row"><div><div class="lbl">Reload computer</div><div class="sub">Start it if it’s down, or attach the existing one. Does not wipe files.</div></div>
                <button class="pill primary" data-act="reload-vm">Reload</button></div>
              <div class="row"><div><div class="lbl">Open in browser</div><div class="sub">Full desktop in a browser tab (the same stream as this window). You can drive it there.</div></div>
                <button class="pill" data-act="open-vm-browser">Open</button></div>
              <div class="row"><div><div class="lbl">Reset computer</div><div class="sub">Destroys this Bot’s Linux desktop and makes a new empty one.</div></div>
                <button class="danger" data-act="reset-vm">Reset</button></div>
            </div>
          </div>`
        }
      </div>
    </div>
  </div>`;
}

function markChips(sel: string, id: string | undefined): void {
  for (const btn of document.querySelectorAll<HTMLElement>(sel)) {
    btn.classList.toggle("on", btn.dataset.id === id);
  }
}

function syncEditorChips(bot: Bot | null | undefined): void {
  if (!state.botEdit || !bot) return;
  const avatar = defaultAvatar(bot.avatar);
  markChips("[data-act=avatar-body]", avatar.body);
  markChips("[data-act=avatar-face]", avatar.expression);
  markChips("[data-act=avatar-anim]", avatar.animation);
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let titlePointerAct = "";

// Delegated click actions, keyed by the element's data-act value.
// A handler returns FALL_THROUGH to mean "not finished": the click handler then
// keeps walking (any not-yet-migrated if-chain) and finally re-renders. Returning
// anything else — including a bare `return;` — ends the click handler with no render,
// exactly as `return` did inside the original chain.
const FALL_THROUGH = Symbol("fall-through");

const chainActs = (...fns: ActHandler[]): ActHandler => (e, ctx) => {
  for (const fn of fns) {
    const outcome = fn(e, ctx);
    if (outcome !== FALL_THROUGH) return outcome;
  }
  return FALL_THROUGH;
};

// data-act: picker, plus-menu
const pickerAct: ActHandler = (e) => {
  state.plusMenu = !state.plusMenu;
  return FALL_THROUGH;
};

// data-act: account-cloud-later
const accountCloudLaterAct: ActHandler = (e) => {
  state.cloudPromptLater = true;
  paintAccountGate();
  return;
};

// data-act: account-cloud-never
const accountCloudNeverAct: ActHandler = (e) => {
  dismissCloudPrompt();
  return;
};

// data-act: toggle-computer, collapse-pane
const toggleComputerAct: ActHandler = (e) => {
  state.showComputer = false;
  state.botEdit = false;
  state.deskSize = "side";
  return FALL_THROUGH;
};

// data-act: expand-pane
const expandPaneAct: ActHandler = (e) => {
  state.showComputer = true;
  state.botEdit = false;
  state.deskSize = "side";
  return FALL_THROUGH;
};

// data-act: open-desk
const openDeskAct: ActHandler = (e) => {
  state.showComputer = true;
  state.botEdit = false;
  state.deskSize = "full";
  return FALL_THROUGH;
};

// data-act: cycle-desk, expand-pane, open-desk, collapse-pane
const cycleDeskAct: ActHandler = (e) => {
  return;
};

// data-act: bot-settings
// Deliberately empty, and load-bearing. The pointerdown listener below already
// toggles state.botEdit for data-act=bot-settings; this swallows the click that
// follows so the ACTIONS path does not toggle it straight back. Returning
// undefined (not FALL_THROUGH) is what makes the dispatcher stop here.
const botSettingsAct: ActHandler = (e) => {
  return;
};

// data-act: avatar-body, avatar-face, avatar-anim
const avatarBodyAct: ActHandler = (e, { el, act }) => {
  const bot = editorBot();
  if (bot && !isLiveCloud()) {
    const field = act === "avatar-body" ? "body" : act === "avatar-face" ? "expression" : "animation";
    bot.avatar = defaultAvatar({
      ...(bot.avatar || {}),
      [field]: el.dataset.id,
    });
    persistEditorBot(bot, { avatar: bot.avatar });
    syncEditorChips(bot);
    refreshAvatars();
  }
  return;
};

// data-act: reload-vm, desk-start-new
const reloadVmAct: ActHandler = (e) => {
  if (isCloudPlace()) return;
  resumeVm();
  return;
};

// data-act: open-harness, open-brain-setup
const openHarnessAct: ActHandler = (e) => {
  openBrainSetup();
  paintHarnessBanner();
  return;
};

// data-act: set-harness, harness-default
const setHarnessAct: ActHandler = (e, { el }) => {
  // Every element carrying this act is rendered with a data-id beside it.
  const provider = el.dataset.id as string;
  const harness = { ...(state.settings?.harness || {}), provider };
  if (provider === "ollama") {
    harness.baseUrl = "http://127.0.0.1:11434/v1";
    harness.model = pickModelForProvider("ollama", harness.model);
  } else if (provider === "lmstudio") {
    harness.baseUrl = "http://127.0.0.1:1234/v1";
    harness.model = pickModelForProvider("lmstudio", harness.model);
  } else if (isCliHost(provider)) {
    harness.model = provider === "cursor" ? pickModelForProvider("cursor", "cursor-grok-4.6-low") : "";
    harness.baseUrl = "https://api.x.ai/v1";
  } else if (provider === "openrouter" || provider === "openai" || provider === "custom") {
    const preset = apiPreset(provider);
    harness.model = pickModelForProvider(provider, preset.model);
    harness.baseUrl = preset.baseUrl;
    harness.apiKeyEnv = "";
  } else {
    harness.model = pickModelForProvider(provider, "grok-4.6");
    harness.baseUrl = "https://api.x.ai/v1";
    harness.apiKeyEnv = "XAI_API_KEY";
  }
  state.settings = { ...(state.settings || {}), harness };
  state.harnessTab = provider;
  paintModal();
  api("/api/settings", { method: "PUT", body: { harness } }).then(async () => {
    await refreshSettings();
    await loadHarnessStatus();
    paintModal();
    render();
    paintHarnessBanner();
    if (provider === "grok-build" && !harnessInfo("grok-build")?.ready) {
      openBrainSetup();
      paintHarnessBanner();
    }
  });
  return;
};

const ACTIONS: Record<string, ActHandler> = {
  "picker": pickerAct,
  "plus-menu": pickerAct,
  "attach-files": (e) => {
    state.plusMenu = false;
    $<HTMLInputElement>("#attach-file")?.click();
    return;
  },
  "drop-attach": (e, { el }) => {
    const i = Number(el.dataset.i);
    if (Number.isFinite(i)) state.attachments.splice(i, 1);
    return FALL_THROUGH;
  },
  "teach-task": (e) => {
    state.plusMenu = false;
    state.botEdit = false;
    state.showComputer = true;
    state.deskSize = "full";
    state.teach = "ready";
    state.teachFrames = [];
    setHumanControl(true);
    return FALL_THROUGH;
  },
  "start-teach": (e) => {
    state.teach = "recording";
    state.teachFrames = [];
    startTeachCapture(state.selected);
    return FALL_THROUGH;
  },
  "stop-teach": (e) => {
    stopTeachCapture();
    finishTeach();
    return;
  },
  "close-teach": (e) => {
    stopTeachCapture();
    state.teach = null;
    state.teachFrames = [];
    state.deskSize = "side";
    return FALL_THROUGH;
  },
  "vault": (e) => {
    if (state.modal === "vault") {
      state.modal = null;
      render();
    } else {
      openVault();
    }
    return;
  },
  "lol": (e) => {
    state.modal = state.modal === "lol" ? null : "lol";
    return FALL_THROUGH;
  },
  "lol-send": (e) => {
    sendFreebotsPrompt();
    return;
  },
  "lol-create": (e) => {
    resetCreateForm();
    state.modal = "create";
    if (isLiveCloud()) {
      state.createCloudKind = "bot";
      rebuildCreateModal();
      loadCloudBilling();
      return;
    }
    Promise.all([loadLocalHarness(), loadHarnessStatus(), loadClaudeAuth()]).then(() => {
      if (state.modal === "create") rebuildCreateModal();
    });
    return FALL_THROUGH;
  },
  "vault-group": (e, { el }) => {
    flushVaultDraft();
    state.vaultGroup = el.dataset.id;
    state.vaultReveal = false;
    state.vaultNaming = false;
    state.vaultShareOpen = false;
    const accs = vaultAccountsInView();
    state.vaultEditId = accs[0]?.id || null;
    state.vaultShare = botsSharingAccount(state.vaultEditId);
    state.vaultSharePacks = [];
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    return FALL_THROUGH;
  },
  "vault-add-group": (e) => {
    state.vaultNaming = true;
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    render();
    setTimeout(() => {
      const input = $<HTMLInputElement>("#vault-group-name");
      if (!input) return;
      input.focus();
      input.select();
    }, 20);
    return;
  },
  "vault-add-account": (e) => {
    flushVaultDraft();
    state.vaultEditId = "new";
    state.vaultReveal = true;
    state.vaultShare = [];
    state.vaultSharePacks = [];
    state.vaultShareOpen = false;
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    return FALL_THROUGH;
  },
  "vault-edit": (e, { el }) => {
    const next = el.dataset.id;
    if (next === state.vaultEditId) return;
    flushVaultDraft();
    state.vaultEditId = next;
    state.vaultReveal = false;
    state.vaultShareOpen = false;
    state.vaultShare = botsSharingAccount(next);
    state.vaultSharePacks = [];
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    return FALL_THROUGH;
  },
  "vault-cancel": (e) => {
    state.vaultEditId = vaultAccountsInView()[0]?.id || null;
    state.vaultReveal = false;
    state.vaultShare = botsSharingAccount(state.vaultEditId);
    state.vaultSharePacks = [];
    state.vaultShareOpen = false;
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    return FALL_THROUGH;
  },
  "vault-reveal": (e) => {
    toggleVaultReveal();
    return;
  },
  "vault-save": (e) => {
    saveVaultAccount();
    return;
  },
  "vault-delete": (e, { el }) => {
    deleteVaultAccount(el.dataset.id);
    return;
  },
  "vault-export": (e) => {
    exportVaultBackup();
    return;
  },
  "vault-import": (e) => {
    $<HTMLInputElement>("#vault-import-file")?.click();
    return;
  },
  "vault-share-toggle": (e) => {
    state.vaultShareOpen = !state.vaultShareOpen;
    paintVaultShare();
    return;
  },
  "vault-share-bot": (e, { el }) => {
    const id = el.dataset.id as string;
    const set = new Set(state.vaultShare || []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    state.vaultShare = [...set];
    state.vaultSharePacks = (state.vaultSharePacks || []).filter((key) => {
      const i = key.indexOf(":");
      const ids = sharePackBots(key.slice(0, i), key.slice(i + 1));
      return !ids.includes(id);
    });
    paintVaultShare();
    persistVaultShare();
    return;
  },
  "vault-share-pack": (e, { el }) => {
    const key = `${el.dataset.kind}:${el.dataset.id}`;
    const ids = sharePackBots(el.dataset.kind, el.dataset.id);
    const packs = new Set(state.vaultSharePacks || []);
    const set = new Set(state.vaultShare || []);
    if (packs.has(key)) {
      packs.delete(key);
      for (const id of ids) set.delete(id);
    } else {
      packs.add(key);
      for (const id of ids) set.add(id);
    }
    state.vaultSharePacks = [...packs];
    state.vaultShare = [...set];
    paintVaultShare();
    persistVaultShare();
    return;
  },
  "account-settings": (e) => {
    state.modal = "settings";
    state.section = "account";
    state.accountError = "";
    return FALL_THROUGH;
  },
  "account-local": (e) => {
    chooseLocalAccount();
    return;
  },
  "account-magic": (e) => {
    const typed = document.querySelector<HTMLInputElement>("[data-account-email]")?.value;
    if (typed != null) state.accountEmail = typed;
    signInAccount();
    return;
  },
  "account-x": (e) => {
    signInWithX();
    return;
  },
  "account-billing": (e) => {
    api("/api/cloud/billing/portal", { method: "POST", body: {} })
      .then((r) => window.open((r as { url?: string }).url || "https://sub8.bot/billing", "_blank"))
      .catch(() => window.open("https://sub8.bot/billing", "_blank"));
    return;
  },
  "account-logout": (e) => {
    logoutAccount();
    return;
  },
  "account-cloud-later": accountCloudLaterAct,
  "account-cloud-never": accountCloudNeverAct,
  "settings": (e) => {
    state.modal = "settings";
    state.section = "general";
    return FALL_THROUGH;
  },
  "profile": (e) => {
    state.modal = "settings";
    state.section = "general";
    return FALL_THROUGH;
  },
  "advanced": (e) => {
    state.modal = "advanced";
    return FALL_THROUGH;
  },
  "stop-turn": (e) => {
    stopTurn();
    return;
  },
  "dismiss-docker-gate": (e) => {
    paintDockerGate();
    return;
  },
  "recover-docker": (e) => {
    recoverDocker();
    return;
  },
  "install-docker": (e) => {
    installDocker();
    return;
  },
  "docker-desktop-docs": (e) => {
    openExternal(dockerInstallUrl());
    return;
  },
  "chat-more": (e) => {
    loadOlderChat();
    return;
  },
  "close-modal": (e) => {
    if (state.claudeAuth?.awaitingCode || state.modal === "claude-code") {
      void claudeDeskLoginCancel();
      return;
    }
    state.modal = null;
    state.botEdit = false;
    state.editingRoutineId = null;
    return FALL_THROUGH;
  },
  "open-url": (e, { el }) => {
    openExternal(el.dataset.url);
    return;
  },
  "sec": (e, { el }) => {
    state.section = el.dataset.id;
    if (el.dataset.id === "identities") {
      Promise.all([loadIdentities(), loadClaudeAuth(), loadHarnessStatus()]).then(() => {
        if (state.modal === "settings" && state.section === "identities") paintModal();
      });
    }
    if (el.dataset.id === "harness") {
      state.harnessTab = state.settings?.harness?.provider || state.harnessTab || "grok-build";
      loadHarnessStatus().then(() => {
        if (state.modal === "settings" && state.section === "harness") paintModal();
      });
      const h = state.settings?.harness;
      // A harness with no model set is not in the list either, so widening the
      // needle rather than asserting it keeps the same answer.
      if (h && (h.provider === "grok-build" || h.provider === "spacexai") && !(grokModels() as (string | undefined)[]).includes(h.model)) {
        const harness = { ...h, model: "grok-4.6", baseUrl: "https://api.x.ai/v1" };
        state.settings = { ...(state.settings || {}), harness };
        api("/api/settings", { method: "PUT", body: { harness } });
      }
      loadLocalHarness().then(() => paintModal());
    }
    return FALL_THROUGH;
  },
  "select": (e, { el }) => {
    rememberSelected(el.dataset.id);
    state.botEdit = false;
    state.confirmDeleteId = null;
    // Hydrate from the row, do not assume false. The host persists Take control
    // and re-arms it at boot, so a bot that was being driven when the app
    // stopped comes back held -- and every wake/routine path skips a held bot.
    // Resetting to false here showed "Take control" for a bot that IS held and
    // left the stream view-only, so the user could neither drive nor release it.
    state.humanControl = Boolean(state.bots.find((b) => b.id === el.dataset.id)?.humanControl);
    if (!isCloudPlace()) {
      const picked = state.bots.find((b) => b.id === el.dataset.id);
      if (picked?.unread) {
        picked.unread = false;
        api(`/api/bots/${picked.id}`, { method: "PATCH", body: { unread: false } });
      }
      loadBotHistory(el.dataset.id);
    }
    return FALL_THROUGH;
  },
  "create": (e) => {
    resetCreateForm();
    state.modal = "create";
    if (isLiveCloud()) {
      state.createCloudKind = "bot";
      rebuildCreateModal();
      loadCloudBilling();
      return;
    }
    Promise.all([loadLocalHarness(), loadHarnessStatus(), loadClaudeAuth()]).then(() => {
      if (state.modal === "create") rebuildCreateModal();
    });
    return FALL_THROUGH;
  },
  "create-team": (e) => {
    if (isLiveCloud()) {
      resetCreateForm();
      state.createCloudKind = "mate";
      state.modal = "create";
      rebuildCreateModal();
      return;
    }
    state.modal = "create-team";
    state.createHarness = "claude";
    return FALL_THROUGH;
  },
  "create-sku": (e, { el }) => {
    state.createSku = el.dataset.id || "vm.4g";
    state.createCloudPay = false;
    rebuildCreateModal();
    return;
  },
  "create-pay-back": (e) => {
    state.createCloudPay = false;
    rebuildCreateModal();
    return;
  },
  "confirm-create": (e) => {
    confirmCreateBot();
    return;
  },
  "confirm-create-team": (e) => {
    confirmCreateTeam();
    return;
  },
  "select-team": (e, { el }) => {
    const rows = isCloudPlace() ? state.cloudDraft?.teams || [] : state.teams || [];
    const team = rows.find((t) => t.id === el.dataset.id) || teamFromBots(el.dataset.id);
    const members = teamBots(team);
    const pick = members.find((b) => b.id === team?.chiefId) || members.find((b) => b.teamRole === "chief") || members[0];
    if (pick) {
      rememberSelected(pick.id);
      loadBotHistory(pick.id);
    }
    return FALL_THROUGH;
  },
  "select-channel": (e, { el }) => {
    const id = el.dataset.id || "";
    state.selectedChannel = state.selectedChannel === id ? null : id;
    paintChannelRail();
    return;
  },
  "mention": (e, { el }) => {
    const ta = $<SendForm>("#send")?.q;
    const name = el.dataset.name;
    if (ta && name) {
      const tag = `@${name} `;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      ta.value = `${ta.value.slice(0, start)}${tag}${ta.value.slice(end)}`;
      const caret = start + tag.length;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      sizeComposer();
    }
    return;
  },
  "team-tab": (e, { el }) => {
    // Cloud teammates live in cloudDraft.bots, not state.bots.
    const b = viewBots().find((x) => x.id === el.dataset.id);
    if (b) {
      rememberSelected(b.id);
      if (isCloudPlace()) {
        render();
      } else {
        loadBotHistory(b.id);
        const team = teamOf(b);
        if (team) api(`/api/teams/${team.id}/focus`, { method: "POST", body: { botId: b.id } }).catch(() => {});
      }
    }
    return FALL_THROUGH;
  },
  "pick-choice": (e, { el }) => {
    submitChoice(el.dataset.mid, el.dataset.cid, "");
    return;
  },
  "send-choice": (e, { el }) => {
    const field = document.querySelector<HTMLInputElement>(`.choice-custom[data-mid="${CSS.escape(el.dataset.mid || "")}"]`);
    const custom = String(field?.value || "").trim();
    if (!custom) return;
    submitChoice(el.dataset.mid, "custom", custom);
    return;
  },
  "dismiss-choice": (e, { el }) => {
    const bot = state.bots.find((b) => b.id === state.selected);
    const card = bot?.messages?.find((m) => m.id === el.dataset.mid);
    if (card) {
      card.pending = false;
      paintChat(bot);
    }
    return;
  },
  "collapse-pane": chainActs(toggleComputerAct, cycleDeskAct),
  "toggle-computer": toggleComputerAct,
  "expand-pane": chainActs(expandPaneAct, cycleDeskAct),
  "collapse-full": (e) => {
    state.showComputer = true;
    state.botEdit = false;
    state.deskSize = "side";
    return FALL_THROUGH;
  },
  "open-desk": chainActs(openDeskAct, cycleDeskAct),
  "cycle-desk": cycleDeskAct,
  "bot-settings": botSettingsAct,
  "edit-bot": (e, { el }) => {
    if (el.dataset.id) rememberSelected(el.dataset.id);
    state.botEdit = true;
    state.showComputer = true;
    state.modal = null;
    if (isCloudPlace()) {
      void loadIdentities().then(() => {
        const bot = currentBot();
        if (state.botEdit && bot) paintBotEditor(bot);
      });
    }
    return FALL_THROUGH;
  },
  "bot-color": (e, { el }) => {
    const bot = editorBot();
    if (bot && el.dataset.color && !isLiveCloud()) {
      bot.color = el.dataset.color;
      persistEditorBot(bot, { color: bot.color });
      refreshAvatars();
    }
    return FALL_THROUGH;
  },
  "avatar-anim": avatarBodyAct,
  "avatar-body": avatarBodyAct,
  "avatar-face": avatarBodyAct,
  "create-face": (e, { el, act }) => {
    state.createFace = el.dataset.id as string;
    markChips("[data-act=create-face]", el.dataset.id);
    refreshAvatars();
    return;
  },
  "bot-notify": (e) => {
    const bot = editorBot();
    if (bot && !isLiveCloud()) {
      bot.notificationsEnabled = !bot.notificationsEnabled;
      persistEditorBot(bot, { notificationsEnabled: bot.notificationsEnabled });
    }
    return FALL_THROUGH;
  },
  "save-bot": (e) => {
    saveBot();
    return;
  },
  "delete-bot": (e, { el }) => {
    if (isLiveCloud()) {
      state.deleteBotId = el.dataset.id || currentBot()?.id;
      state.modal = "delete-bot";
      state.botEdit = false;
      render();
      return;
    }
    if (isCloudPlace()) {
      const bot = botById(el.dataset.id) || currentBot();
      if (!confirm(`Remove “${bot?.name || "this Bot"}” from Cloud? The draft desk stays.`)) return;
      deleteBot(el.dataset.id || bot?.id, true);
      return;
    }
    state.deleteBotId = el.dataset.id;
    state.modal = "delete-bot";
    state.botEdit = false;
    loadComputers().then(() => render());
    render();
    return;
  },
  "delete-bot-go": (e, { el }) => {
    deleteBot(state.deleteBotId, el.dataset.keep !== "0");
    return;
  },
  "computers": (e) => {
    state.modal = "computers";
    state.computerAttach = false;
    loadComputers().then(() => {
      if (!state.computerId) state.computerId = state.computers[0]?.id || null;
      paintModal();
      refreshComputerPreviews();
      loadComputerImages(state.computerId);
    });
    render();
    return;
  },
  "computer-view": (e, { el }) => {
    state.computerView = el.dataset.id === "list" ? "list" : "grid";
    try {
      localStorage.setItem("sub8.computerView", state.computerView);
    } catch {
      /* ignore */
    }
    paintModal();
    return;
  },
  "open-computer-bot": (e, { el }) => {
    const id = el.dataset.id;
    if (!id) return;
    state.modal = null;
    state.computerAttach = false;
    rememberSelected(id);
    state.botEdit = false;
    state.confirmDeleteId = null;
    // Same as the select handler above: the flag survives a restart on the host.
    state.humanControl = Boolean(state.bots.find((b) => b.id === id)?.humanControl);
    if (!isCloudPlace()) {
      const picked = state.bots.find((b) => b.id === id);
      if (picked?.unread) {
        picked.unread = false;
        api(`/api/bots/${picked.id}`, { method: "PATCH", body: { unread: false } });
      }
      loadBotHistory(id);
    }
    render();
    return;
  },
  "computer-select": (e, { el }) => {
    state.computerId = el.dataset.id;
    state.computerAttach = false;
    paintModal();
    loadComputerImages(state.computerId);
    return;
  },
  "computer-attach-open": (e, { el }) => {
    state.computerId = el.dataset.id;
    state.computerAttach = true;
    paintModal();
    return;
  },
  "computer-attach": (e, { el }) => {
    computerAction(el.dataset.id, "attach", { botId: el.dataset.bot });
    return;
  },
  "computer-act": (e, { el }) => {
    const doit = el.dataset.do;
    if (doit === "destroy" && !confirm(isCloudPlace() ? "Destroy this draft computer?" : "Destroy this computer and its files? This cannot be undone.")) return;
    if (isCloudPlace()) {
      destroyCloudComputer(el.dataset.id);
      return;
    }
    computerAction(el.dataset.id, doit);
    return;
  },
  "desk-snap": (e, { el }) => {
    snapshotDesk(el.dataset.id);
    return;
  },
  "desk-restore": (e, { el }) => {
    if (!confirm("This replaces the desk’s files with the snapshot. The bot’s chat does not change.")) return;
    restoreDeskImage(el.dataset.id, el.dataset.image);
    return;
  },
  "desk-image-del": (e, { el }) => {
    deleteDeskImage(el.dataset.id, el.dataset.image);
    return;
  },
  "place": (e, { el }) => {
    switchPlace(el.dataset.id);
    return;
  },
  "cloud-new-computer": (e) => {
    if (isLiveCloud()) {
      resetCreateForm();
      state.createCloudKind = "bot";
      state.modal = "create";
      rebuildCreateModal();
      loadCloudBilling();
      return;
    }
    createCloudComputer().catch((err) => window.alert((err as CaughtError).message || "Could not create a draft desk."));
    return;
  },
  "cloud-harness-grok": (e, { el }) => {
    signCloudHarness(el.dataset.id, "grok");
    return;
  },
  "cloud-harness-key": (e, { el }) => {
    signCloudHarness(el.dataset.id, "key");
    return;
  },
  "cloud-brain-grok": (e) => {
    startCloudGrokOAuth();
    return;
  },
  "cloud-brain-key-save": (e) => {
    saveCloudBrainKey();
    return;
  },
  "reset-vm": (e) => {
    if (confirm("Reset this Bot’s computer? Files and logins on that desktop will be gone.")) resetVm();
    return;
  },
  "check-update": (e) => {
    state.updateBusy = true;
    paintModal();
    checkForUpdate({ silent: false }).finally(() => {
      state.updateBusy = false;
      paintModal();
    });
    return;
  },
  "install-update": (e) => {
    openDownload();
    return;
  },
  "open-site": (e) => {
    openOfficialSite();
    return;
  },
  "dismiss-update": (e) => {
    dismissUpdateBanner();
    return;
  },
  "desk-start-new": reloadVmAct,
  "reload-vm": reloadVmAct,
  "refresh-stream": (e) => {
    if (isCloudPlace()) {
      liveFrameKey = null;
      attachLiveFrame(currentBot());
      return;
    }
    reconnectStream();
    return;
  },
  "reboot-vm": (e) => {
    if (isCloudPlace()) return;
    rebootVm();
    return;
  },
  "open-vm-browser": (e) => {
    const bot = state.bots.find((b) => b.id === state.selected);
    const port = bot?.vm?.novncPort;
    if (port) window.open(`http://127.0.0.1:${port}/`, "_blank");
    else resumeVm().then(() => {
      const b = state.bots.find((x) => x.id === state.selected);
      if (b?.vm?.novncPort) window.open(`http://127.0.0.1:${b.vm.novncPort}/`, "_blank");
    });
    return;
  },
  "add-routine": (e) => {
    state.modal = "routine";
    state.editingRoutineId = null;
    // Cloud fires on an interval only, so seed a valid one rather than the
    // empty trigger list the local editor starts from.
    state.routineTriggers = isCloudPlace() ? [{ id: newTriggerId(), kind: "hourly", intervalMs: 3600_000 }] : [];
    state.schedPop = null;
    render();
    return;
  },
  "edit-routine": (e, { el }) => {
    const row = isCloudPlace()
      ? cloudRoutineRows(currentBot()).find((x) => x.id === el.dataset.id)
      : (state.bots.find((b) => b.id === state.selected)?.routines || []).find((x) => x.id === el.dataset.id);
    state.modal = "routine";
    state.editingRoutineId = el.dataset.id;
    state.routineTriggers = clientTriggers(row);
    state.schedPop = null;
    render();
    return;
  },
  "delete-routine": (e, { el }) => {
    deleteRoutine(el.dataset.id);
    return;
  },
  "toggle-routine": (e, { el }) => {
    toggleRoutine(el.dataset.id);
    return;
  },
  "routine-group": (e, { el }) => {
    const hidden = $<HTMLInputElement>("#rg");
    if (hidden) hidden.value = el.dataset.id as string;
    document.querySelectorAll("#rg-seg .seg-btn").forEach((b) => b.classList.toggle("on", b === el));
    return;
  },
  "routine-enabled": (e, { el }) => {
    el.classList.toggle("on");
    persistRoutine({ close: false });
    return;
  },
  "save-routine": (e) => {
    persistRoutine({ close: true });
    return;
  },
  "delete-routine-editor": (e) => {
    const id = state.editingRoutineId;
    state.schedPop = null;
    if (id) deleteRoutine(id);
    else {
      state.modal = null;
      state.editingRoutineId = null;
      render();
    }
    return;
  },
  "test-routine": (e) => {
    testRoutine();
    return;
  },
  "sched-open": (e, { el }) => {
    openSchedPop(el, "root");
    return;
  },
  "sched-kind-open": (e) => {
    if (state.schedPop) state.schedPop = { ...state.schedPop, panel: "kinds" };
    paintSchedPop();
    return;
  },
  "sched-kind": (e, { el }) => {
    const kind = el.dataset.kind;
    if (kind === "hourly") {
      addRoutineTrigger({ kind: "hourly", intervalMs: 3600_000 });
      return;
    }
    if (kind === "interval") {
      if (state.schedPop) state.schedPop = { ...state.schedPop, panel: "interval", intervalN: 2, intervalUnit: "hours" };
      paintSchedPop();
      return;
    }
    if (kind === "advanced") {
      if (state.schedPop) state.schedPop = { ...state.schedPop, panel: "advanced" };
      paintSchedPop();
      return;
    }
    if (state.schedPop) state.schedPop = { ...state.schedPop, panel: "times", timeKind: kind };
    paintSchedPop();
    return;
  },
  "sched-time": (e, { el }) => {
    const hour = Number(el.dataset.hour);
    const minute = Number(el.dataset.minute);
    const kind = state.schedPop?.timeKind || "daily";
    const now = new Date();
    if (kind === "weekly") addRoutineTrigger({ kind: "weekly", weekday: now.getDay(), times: [{ hour, minute }] });
    else if (kind === "monthly") addRoutineTrigger({ kind: "monthly", monthDay: now.getDate(), times: [{ hour, minute }] });
    else addRoutineTrigger({ kind, times: [{ hour, minute }] });
    return;
  },
  "sched-interval-add": (e) => {
    const n = Math.max(1, Number($<HTMLInputElement>("#sched-n")?.value || state.schedPop?.intervalN || 2));
    const unit = $<HTMLSelectElement>("#sched-unit")?.value || state.schedPop?.intervalUnit || "hours";
    const intervalMs = unit === "minutes" ? n * 60_000 : n * 3600_000;
    addRoutineTrigger({ kind: n === 1 && unit === "hours" ? "hourly" : "interval", intervalMs });
    return;
  },
  "sched-advanced-add": (e) => {
    const mode = state.schedPop?.panel === "custom" ? "custom" : "advanced";
    if (mode === "custom") {
      const cron = ($<HTMLInputElement>("#sched-cron")?.value || "0 8 * * *").trim();
      addRoutineTrigger({ kind: "cron", cron });
      return;
    }
    const month = Number($<HTMLSelectElement>("#sched-months")?.value || 0);
    const days = $<HTMLSelectElement>("#sched-days")?.value === "weekdays" ? "weekdays" : "every";
    const raw = $<HTMLSelectElement>("#sched-adv-time")?.value || "8:0";
    const [hour, minute] = raw.split(":").map(Number);
    const extra = state.schedPop?.advanced?.times || [];
    const times = extra.length ? extra : [{ hour, minute }];
    if (!extra.length) times[0] = { hour, minute };
    addRoutineTrigger({ kind: "advanced", months: month ? [month] : [], days, times });
    return;
  },
  "sched-add-time": (e) => {
    if (!state.schedPop) return;
    const adv = { ...(state.schedPop.advanced || { times: [{ hour: 8, minute: 0 }] }) };
    const raw = $<HTMLSelectElement>("#sched-adv-time")?.value || "9:0";
    const [hour, minute] = raw.split(":").map(Number);
    adv.times = [...(adv.times || []), { hour, minute }];
    state.schedPop = { ...state.schedPop, advanced: adv };
    paintSchedPop();
    return;
  },
  "sched-remove": (e, { el }) => {
    e.stopPropagation();
    removeRoutineTrigger(el.dataset.id);
    return;
  },
  "sched-edit": (e, { el }) => {
    const row = (state.routineTriggers || []).find((t) => t.id === el.dataset.id);
    if (!row) return;
    if (row.kind === "cron") {
      state.schedPop = { panel: "custom", x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().bottom + 6, advanced: { cron: row.cron, months: [], days: "every", times: [{ hour: 8, minute: 0 }] }, editId: row.id };
      paintSchedPop();
      return;
    }
    if (row.kind === "advanced") {
      state.schedPop = { panel: "advanced", x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().bottom + 6, advanced: { months: row.months || [], days: row.days || "every", times: row.times || [{ hour: 8, minute: 0 }], cron: "0 8 * * *" }, editId: row.id };
      paintSchedPop();
      return;
    }
    if (row.kind === "interval" || row.kind === "hourly") {
      const mins = Math.max(1, Math.round((row.intervalMs || 3600_000) / 60_000));
      const hours = mins % 60 === 0;
      openSchedPop(el, "interval");
      // openSchedPop() has just assigned state.schedPop.
      state.schedPop = { ...state.schedPop!, intervalN: hours ? mins / 60 : mins, intervalUnit: hours ? "hours" : "minutes", editId: row.id };
      paintSchedPop();
      return;
    }
    openSchedPop(el, "times");
    // openSchedPop() has just assigned state.schedPop.
    state.schedPop = { ...state.schedPop!, timeKind: row.kind === "weekly" || row.kind === "monthly" || row.kind === "weekdays" ? row.kind : "daily", editId: row.id };
    paintSchedPop();
    return;
  },
  "dictate": (e) => {
    toggleDictate();
    return;
  },
  "send": (e) => {
    $<SendForm>("#send")?.dispatchEvent(new Event("submit"));
    return FALL_THROUGH;
  },
  "dismiss-job": (e, { el }) => {
    const bot = state.bots.find((b) => b.id === state.selected);
    const team = teamOf(bot);
    const teamId = el.dataset.id || team?.id;
    if (!teamId) return;
    if (team) delete team.job;
    paintJobBar(bot);
    void api(`/api/teams/${encodeURIComponent(teamId)}/job`, { method: "DELETE" }).catch(() => {});
    return;
  },
  "hide-team-brief": (e, { el }) => {
    const bot = state.bots.find((b) => b.id === el.dataset.id || b.id === state.selected);
    const team = teamOf(bot);
    if (team) setTeamBriefHidden(team.id, true);
    state.ctx = null;
    paintCtxMenu();
    paintTeamBrief(bot);
    return;
  },
  "show-team-brief": (e, { el }) => {
    const bot = state.bots.find((b) => b.id === el.dataset.id || b.id === state.selected);
    const team = teamOf(bot);
    if (team) setTeamBriefHidden(team.id, false);
    state.ctx = null;
    paintCtxMenu();
    paintTeamBrief(bot || state.bots.find((b) => b.id === state.selected));
    return;
  },
  "ctx-rename-tab-open": (e) => {
    if (state.ctx?.type === "tab") state.ctx = { ...state.ctx, naming: true };
    paintCtxMenu();
    return;
  },
  "ctx-rename-tab": (e, { el }) => {
    const id = el.dataset.id || state.ctx?.botId;
    const name = ($<HTMLInputElement>("#ctx-tab-name")?.value || "").trim();
    const b = botById(id) || state.bots.find((x) => x.id === id);
    if (b && name) {
      b.name = name;
      if (isLiveCloud()) {
        api(`/api/cloud/draft/bots/${b.id}`, {
          method: "PATCH",
          body: { computerId: cloudDeskIdOf(b), name },
        }).then((snap) => {
          if (snap) state.cloudDraft = snap;
          render();
        });
      } else {
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { name } });
      }
    }
    state.ctx = null;
    render();
    return;
  },
  "ctx-tab-remove": (e, { el }) => {
    const id = el.dataset.id || state.ctx?.botId;
    const b = botById(id) || state.bots.find((x) => x.id === id);
    state.ctx = null;
    paintCtxMenu();
    if (!b) return;
    if (isLiveCloud()) {
      state.deleteBotId = id;
      state.modal = "delete-bot";
      render();
      return;
    }
    const team = teamOf(b);
    const label = team ? `Remove “${b.name}” from ${team.name}? The shared desk stays.` : `Remove “${b.name}”?`;
    if (!confirm(label)) return;
    deleteBot(id, true);
    return;
  },
  "ctx-rename-team-open": (e) => {
    if (state.ctx?.type === "team") state.ctx = { ...state.ctx, naming: true, sub: null };
    paintCtxMenu();
    return;
  },
  "ctx-rename-team": (e, { el }) => {
    const id = el.dataset.id || state.ctx?.teamId;
    const name = ($<HTMLInputElement>("#ctx-team-name")?.value || "").trim();
    if (id && name) renameTeam(id, name);
    state.ctx = null;
    render();
    return;
  },
  "ctx-pin": (e, { el }) => {
    if (state.ctx?.type === "team") {
      // The if() above proved state.ctx; the callback is what loses the narrowing.
      const t = (state.teams || []).find((x) => x.id === (el.dataset.id || state.ctx!.teamId));
      if (t) {
        t.pinned = !t.pinned;
        api(`/api/teams/${t.id}`, { method: "PATCH", body: { pinned: t.pinned } }).then(upsertLocalTeam as (saved: unknown) => void);
      }
      state.ctx = null;
      render();
      return;
    }
    const b = state.bots.find((x) => x.id === el.dataset.id);
    if (b) {
      b.pinned = !b.pinned;
      api(`/api/bots/${b.id}`, { method: "PATCH", body: { pinned: b.pinned } });
    }
    state.ctx = null;
    render();
    return;
  },
  "ctx-move-open": (e) => {
    if (state.ctx) state.ctx = { ...state.ctx, sub: state.ctx.sub === "move" ? null : "move", naming: false };
    paintCtxMenu();
    return;
  },
  "ctx-new-section": (e) => {
    if (state.ctx) state.ctx = { ...state.ctx, naming: true, sub: "move" };
    paintCtxMenu();
    return;
  },
  "ctx-rename-section-open": (e, { el }) => {
    if (state.ctx?.type === "section") state.ctx = { ...state.ctx, naming: true };
    else {
      const sec = sidebarSections().find((s) => s.id === el.dataset.sec);
      if (sec) state.ctx = { type: "section", secId: sec.id, x: state.ctx?.x || 80, y: state.ctx?.y || 80, naming: true };
    }
    paintCtxMenu();
    return;
  },
  "ctx-rename-section": (e, { el }) => {
    const id = el.dataset.sec || state.ctx?.secId;
    const name = ($<HTMLInputElement>("#ctx-sec-name")?.value || "").trim();
    if (!id || !name) return;
    const sections = sidebarSections().map((s) => (s.id === id ? { ...s, name } : s));
    state.settings = { ...(state.settings || {}), sidebarSections: sections };
    api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
    state.ctx = null;
    render();
    return;
  },
  "ctx-del-msg": (e) => {
    const ids = [state.ctx?.mid, ...(String(state.ctx?.mids || "").split(","))]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    state.ctx = null;
    paintCtxMenu();
    if (ids.length) deleteMessages(ids);
    return;
  },
  "ctx-delete-section": (e, { el }) => {
    const id = el.dataset.sec || state.ctx?.secId;
    if (!id) return;
    const sec = sidebarSections().find((s) => s.id === id);
    if (sec && !confirm(`Delete “${sec.name}”? Bots and groups in it stay, unassigned.`)) return;
    const sections = sidebarSections().filter((s) => s.id !== id);
    state.settings = { ...(state.settings || {}), sidebarSections: sections };
    for (const b of state.bots) {
      if (b.section === id) {
        b.section = "";
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: "" } });
      }
    }
    for (const t of state.teams || []) {
      if (t.section === id) {
        t.section = "";
        api(`/api/teams/${t.id}`, { method: "PATCH", body: { section: "" } }).then(upsertLocalTeam as (saved: unknown) => void);
      }
    }
    api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
    state.ctx = null;
    render();
    return;
  },
  "ctx-create-section": (e, { el }) => {
    const name = ($<HTMLInputElement>("#ctx-sec-name")?.value || "").trim();
    if (!name) return;
    const id = `sec_${Date.now().toString(36)}`;
    const sections = [...sidebarSections(), { id, name }];
    state.settings = { ...(state.settings || {}), sidebarSections: sections };
    const kind = el.dataset.kind || state.ctx?.type;
    if (kind === "team") {
      moveTeamTo(el.dataset.id || state.ctx?.teamId, { section: id, pinned: false });
    } else {
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.section = id;
        b.pinned = false;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: id, pinned: false } });
      }
    }
    api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
    state.ctx = null;
    render();
    return;
  },
  "ctx-move": (e, { el }) => {
    const sec = el.dataset.sec || "";
    if (el.dataset.kind === "team" || state.ctx?.type === "team") {
      moveTeamTo(el.dataset.id || state.ctx?.teamId, { section: sec, pinned: false });
      state.ctx = null;
      render();
      return;
    }
    const b = state.bots.find((x) => x.id === el.dataset.id);
    if (b) {
      b.section = sec;
      api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: sec } });
    }
    state.ctx = null;
    render();
    return;
  },
  "ctx-unread": (e, { el }) => {
    const b = state.bots.find((x) => x.id === el.dataset.id);
    if (b) {
      b.unread = !b.unread;
      api(`/api/bots/${b.id}`, { method: "PATCH", body: { unread: b.unread } });
    }
    state.ctx = null;
    render();
    return;
  },
  "ctx-edit": (e, { el }) => {
    rememberSelected(el.dataset.id);
    state.botEdit = true;
    state.showComputer = true;
    state.ctx = null;
    render();
    return;
  },
  "ctx-dup": (e, { el }) => {
    api(`/api/bots/${el.dataset.id}/duplicate`, { method: "POST" }).then((copy) => {
      if ((copy as Bot | null)?.id) rememberSelected((copy as Bot).id);
      state.ctx = null;
      return refresh();
    });
    return;
  },
  "ctx-copy": (e, { el }) => {
    navigator.clipboard?.writeText(el.dataset.id || "");
    state.ctx = null;
    paintCtxMenu();
    return;
  },
  "ctx-hide": (e, { el }) => {
    const b = state.bots.find((x) => x.id === el.dataset.id);
    if (b) {
      b.hidden = !b.hidden;
      api(`/api/bots/${b.id}`, { method: "PATCH", body: { hidden: b.hidden } });
      if (b.hidden && state.selected === b.id) {
        const next = state.bots.find((x) => !x.hidden && x.id !== b.id);
        rememberSelected(next?.id || null);
      }
    }
    state.ctx = null;
    render();
    return;
  },
  "ctx-del": (e, { el }) => {
    const id = el.dataset.id;
    state.ctx = null;
    paintCtxMenu();
    if (isLiveCloud()) {
      state.deleteBotId = id;
      state.modal = "delete-bot";
      render();
      return;
    }
    if (isCloudPlace()) {
      const bot = botById(id) || currentBot();
      if (!id || !confirm(`Remove “${bot?.name || "this Bot"}” from Cloud? The draft desk stays.`)) return;
      deleteBot(id, true);
      return;
    }
    if (id) {
      state.deleteBotId = id;
      state.modal = "delete-bot";
      loadComputers().then(() => render());
      render();
    }
    return;
  },
  "set-pref": (e, { el }) => {
    // The markup that carries data-act="set-pref" always carries data-set too.
    state.settings = { ...(state.settings || {}), [el.dataset.set as string]: el.dataset.id };
    applyTheme();
    paintModal();
    api("/api/settings", { method: "PUT", body: { [el.dataset.set as string]: el.dataset.id } }).then(async () => {
      await refreshSettings();
      applyTheme();
    });
    return;
  },
  "harness-tab": (e, { el }) => {
    state.harnessTab = el.dataset.id;
    paintModal();
    return;
  },
  "refresh-harness-status": (e) => {
    loadHarnessStatus().then(() => {
      paintModal();
      paintHarnessBanner();
    });
    return;
  },
  "open-brain-setup": openHarnessAct,
  "open-harness": openHarnessAct,
  "dismiss-harness-banner": (e, { el }) => {
    const id = el.dataset.id;
    if (id) state.harnessBannerDismissed[id] = true;
    paintHarnessBanner();
    return;
  },
  "harness-default": setHarnessAct,
  "set-harness": setHarnessAct,
  "take-control": (e) => {
    setHumanControl(true);
    return;
  },
  "release-control": (e) => {
    setHumanControl(false);
    return;
  },
  "refresh-local-harness": (e) => {
    if (state.modal === "create") snapshotCreateForm();
    loadLocalHarness().then(() => {
      if (state.modal === "create") rebuildCreateModal();
      else paintModal();
      if (state.botEdit) {
        const bot = state.bots.find((b) => b.id === state.selected);
        const host = $("#bot-editor");
        if (host) delete host.dataset.bot;
        if (bot) paintBotEditor(bot);
      }
    });
    return;
  },
  "test-harness": (e, { el }) => {
    testHarness(el.dataset.id);
    return;
  },
  "identity-add": () => {
    const provider = $<ValueEl>("#identity-add-provider")?.value || "claude";
    void (async () => {
      try {
        await api("/api/identities", { method: "POST", body: { provider, isolated: true } });
        await loadIdentities();
        if (state.modal === "settings" && state.section === "identities") paintModal();
      } catch (err) {
        window.alert((err as CaughtError).message || "Could not add that identity.");
      }
    })();
    return;
  },
  "grok-oauth": (e) => {
    startGrokOAuth();
    return;
  },
  // Claude desk login -- the desktop twin of the iOS flow. The Worker parks
  // `claude auth login` on the droplet and hands back a claude.com URL; the user
  // approves there and pastes the code back. Starting twice kills the parked
  // child, so the code is collected immediately rather than left open.
  "claude-login": () => {
    void claudeDeskLogin();
    return;
  },
  "claude-code-submit": () => {
    void claudeDeskSubmitCode();
    return;
  },
  "claude-login-cancel": () => {
    void claudeDeskLoginCancel();
    return;
  },
  "claude-logout": () => {
    void claudeDeskLogout();
    return;
  },
  "grok-auth-later": (e) => {
    state.grokAuthAsk = "later";
    paintGrokAuth();
    return;
  },
  "grok-auth-now": (e) => {
    state.grokAuthAsk = "pending";
    paintGrokAuth();
    startGrokOAuth();
    return;
  },
  "brain-tab": (e, { el }) => {
    if (state.brainSetup) {
      if (state.brainSetup.tab === "api") readBrainApiForm();
      state.brainSetup.tab = el.dataset.id === "api" ? "api" : "harness";
    }
    paintBrainSetup();
    return;
  },
  "brain-preset": (e, { el }) => {
    const preset = apiPreset(el.dataset.id);
    if (state.brainSetup) {
      state.brainSetup.api = { preset: preset.id, baseUrl: preset.baseUrl, model: preset.model, apiKey: state.brainSetup.api?.apiKey || "" };
    }
    paintBrainSetup();
    return;
  },
  "brain-install": (e, { el }) => {
    const pack = HARNESS_INSTALL[el.dataset.id as string];
    if (pack?.url) openExternal(pack.url);
    return;
  },
  "brain-signin": (e, { el }) => {
    if (el.dataset.id === "grok-build") startGrokOAuth();
    else {
      const pack = HARNESS_INSTALL[el.dataset.id as string];
      if (pack?.url) openExternal(pack.url);
    }
    return;
  },
  "brain-use": (e, { el }) => {
    useHarnessFromSetup(el.dataset.id);
    return;
  },
  "brain-api-save": (e) => {
    saveApiFromSetup();
    return;
  },
  "brain-later": (e) => {
    skipBrainSetup();
    return;
  },
};

function bindDelegated(): void {
  document.addEventListener("focusin", (e) => {
    if (!isCloudPlace() || state.humanControl) return;
    // A delegated listener only ever sees element targets here.
    const frame = e.target as HTMLElement | null;
    if (frame?.tagName !== "IFRAME" || !frame.classList.contains("cloud-novnc")) return;
    const field = $<SendForm>("#send")?.q;
    restoreFieldFocus(field);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLInputElement | null)?.classList?.contains("choice-custom")) {
      e.preventDefault();
      submitChoice((e.target as HTMLInputElement).dataset.mid, "custom", (e.target as HTMLInputElement).value.trim());
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.id === "ctx-sec-name") {
      e.preventDefault();
      const save = document.querySelector<HTMLElement>("[data-act=ctx-rename-section], [data-act=ctx-create-section]");
      save?.click();
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.id === "ctx-tab-name") {
      e.preventDefault();
      document.querySelector<HTMLElement>("[data-act=ctx-rename-tab]")?.click();
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.id === "ctx-team-name") {
      e.preventDefault();
      document.querySelector<HTMLElement>("[data-act=ctx-rename-team]")?.click();
      return;
    }
    if (e.key === "Enter" && ((e.target as HTMLElement | null)?.id === "sched-n" || (e.target as HTMLElement | null)?.id === "sched-cron")) {
      e.preventDefault();
      document.querySelector<HTMLElement>("[data-act=sched-interval-add], [data-act=sched-advanced-add]")?.click();
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.hasAttribute?.("data-account-email")) {
      e.preventDefault();
      document.querySelector<HTMLElement>("[data-act=account-magic]")?.click();
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.id === "claude-auth-code") {
      e.preventDefault();
      void claudeDeskSubmitCode();
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement | null)?.id === "vault-group-name") {
      e.preventDefault();
      addVaultGroup();
      return;
    }
    if (e.key === "Escape" && (e.target as HTMLElement | null)?.id === "vault-group-name") {
      e.preventDefault();
      state.vaultNaming = false;
      const host = $("#modal-host");
      if (host) delete host.dataset.key;
      render();
      return;
    }
    if (e.key === "Escape" && state.teach) {
      stopTeachCapture();
      state.teach = null;
      state.teachFrames = [];
      state.deskSize = "side";
      render();
      return;
    }
    if (e.key === "Escape" && state.plusMenu) {
      state.plusMenu = false;
      render();
      return;
    }
    if (e.key === "Escape" && state.deskSize === "full" && !state.modal) {
      state.deskSize = "side";
      render();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act=cycle-desk], [data-act=expand-pane], [data-act=open-desk], [data-act=bot-settings], [data-act=collapse-pane], [data-act=collapse-full], [data-act=vault], [data-act=computers], [data-act=settings], [data-act=profile], [data-act=account-settings]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const act = el.dataset.act;
    if (act === "vault") {
      titlePointerAct = "vault";
      if (state.modal === "vault") {
        state.modal = null;
        render();
      } else {
        openVault();
      }
      return;
    }
    if (act === "computers") {
      titlePointerAct = "computers";
      state.modal = "computers";
      state.computerAttach = false;
      loadComputers().then(() => {
        if (!state.computerId) state.computerId = state.computers[0]?.id || null;
        paintModal();
        refreshComputerPreviews();
      });
      render();
      return;
    }
    if (act === "account-settings") {
      titlePointerAct = act;
      state.modal = "settings";
      state.section = "account";
      state.accountError = "";
      render();
      return;
    }
    if (act === "settings" || act === "profile") {
      titlePointerAct = act;
      state.modal = "settings";
      state.section = "general";
      render();
      return;
    }
    if (act === "expand-pane") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "collapse-pane") {
      state.showComputer = false;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "collapse-full") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "bot-settings") {
      state.botEdit = !state.botEdit;
      if (state.botEdit) state.showComputer = true;
    } else if (act === "open-desk") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "full";
    } else {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = state.deskSize === "full" ? "side" : "full";
    }
    render();
  });
  document.addEventListener("contextmenu", (e) => {
    const msg = (e.target as HTMLElement).closest<HTMLElement>(".bubble[data-mid], .tool-list[data-mids]");
    if (msg && (msg.dataset.mid || msg.dataset.mids)) {
      e.preventDefault();
      state.ctx = {
        type: "message",
        mid: msg.dataset.mid || "",
        mids: msg.dataset.mids || "",
        x: e.clientX,
        y: e.clientY,
      };
      paintCtxMenu();
      return;
    }
    const sec = (e.target as HTMLElement).closest<HTMLElement>(".rail-sec");
    if (sec && isNamedSection(sec.dataset.sec)) {
      e.preventDefault();
      state.ctx = { type: "section", secId: sec.dataset.sec, x: e.clientX, y: e.clientY, naming: false };
      paintCtxMenu();
      return;
    }
    const tab = (e.target as HTMLElement).closest<HTMLElement>(".chrome-tab");
    if (tab?.dataset.id) {
      e.preventDefault();
      state.ctx = { type: "tab", botId: tab.dataset.id, x: e.clientX, y: e.clientY, naming: false };
      paintCtxMenu();
      return;
    }
    const tabs = (e.target as HTMLElement).closest<HTMLElement>(".chrome-tabs");
    if (tabs) {
      e.preventDefault();
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot?.teamId) {
        state.ctx = { type: "tab", botId: bot.id, x: e.clientX, y: e.clientY, naming: false };
        paintCtxMenu();
      }
      return;
    }
    const teamRail = (e.target as HTMLElement).closest<HTMLElement>(".rail-team");
    if (teamRail?.dataset.id) {
      e.preventDefault();
      state.ctx = { type: "team", teamId: teamRail.dataset.id, x: e.clientX, y: e.clientY, sub: null, naming: false };
      paintCtxMenu();
      return;
    }
    const rail = (e.target as HTMLElement).closest<HTMLElement>(".rail-bot");
    if (!rail) return;
    e.preventDefault();
    state.ctx = { type: "bot", botId: rail.dataset.id, x: e.clientX, y: e.clientY, sub: null, naming: false };
    paintCtxMenu();
  });
  document.addEventListener("dblclick", (e) => {
    const teamRail = (e.target as HTMLElement).closest<HTMLElement>(".rail-team");
    if (teamRail?.dataset.id) {
      e.preventDefault();
      const r = teamRail.getBoundingClientRect();
      state.ctx = { type: "team", teamId: teamRail.dataset.id, x: r.right + 8, y: r.top, naming: true, sub: null };
      paintCtxMenu();
      return;
    }
    const sec = (e.target as HTMLElement).closest<HTMLElement>(".rail-sec");
    if (!sec || !isNamedSection(sec.dataset.sec)) return;
    e.preventDefault();
    const r = sec.getBoundingClientRect();
    state.ctx = { type: "section", secId: sec.dataset.sec, x: r.right + 8, y: r.top, naming: true };
    paintCtxMenu();
  });
  document.addEventListener("click", (e) => {
    if (state.ctx && !(e.target as HTMLElement).closest<HTMLElement>("#ctx-host, .ctx-menu, .ctx-sub, .ctx-prompt")) {
      state.ctx = null;
      paintCtxMenu();
    }
    if (state.schedPop && !(e.target as HTMLElement).closest<HTMLElement>("#sched-host, [data-act=sched-open], [data-act=sched-edit], .re-when")) {
      state.schedPop = null;
      paintSchedPop();
    }
    if (state.plusMenu && !(e.target as HTMLElement).closest<HTMLElement>(".plus-menu, [data-act=plus-menu]")) {
      state.plusMenu = false;
    }
    if ((e.target as HTMLElement).classList && (e.target as HTMLElement).classList.contains("overlay")) {
      if ((e.target as HTMLElement).classList.contains("docker-gate-overlay") || (e.target as HTMLElement).closest<HTMLElement>("#docker-gate")) {
        paintDockerGate();
        return;
      }
      if (state.modal === "claude-code") return;
      state.modal = null;
      state.botEdit = false;
      state.editingRoutineId = null;
      render();
      return;
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    // Overlay carries data-act only as a fallback; inner modal clicks must not inherit it.
    if (!el || el.classList.contains("overlay")) return;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.tagName !== "A") {
      e.preventDefault();
    }
    // The selector required the attribute, so dataset.act is a string here.
    const act = el.dataset.act as string;
    if (titlePointerAct && titlePointerAct === act) {
      titlePointerAct = "";
      return;
    }
    const handler = Object.hasOwn(ACTIONS, act) ? ACTIONS[act] : null;
    if (handler && handler(e, { el, act }) !== FALL_THROUGH) return;
    render();
  });
  document.addEventListener("change", async (e) => {
    // A change event only fires on a form control.
    const el = e.target as ValueEl;
    if (el.id === "bid" && state.botEdit && isCloudPlace()) {
      const bot = editorBot();
      if (bot) {
        const attach = editorHarnessFromIdentity(bot);
        bot.identityId = attach.identityId;
        bot.harness = { ...(bot.harness || {}), provider: attach.provider, model: attach.model };
        const host = $("#bot-editor");
        if (host) delete host.dataset.bot;
        paintBotEditor(bot);
        if (isLiveCloud()) void persistCloudIdentity(bot, attach);
      }
      return;
    }
    if (el.classList?.contains("sched-mode") && state.schedPop) {
      state.schedPop = { ...state.schedPop, panel: el.value === "custom" ? "custom" : "advanced" };
      paintSchedPop();
      return;
    }
    if (el.dataset.set) {
      await api("/api/settings", { method: "PUT", body: { [el.dataset.set]: el.value } });
      await refreshSettings();
    }
    if (el.dataset.harness) {
      // Reached only from a control the painters no longer render; state.settings
      // is loaded before any change can fire either way.
      const harness = { ...state.settings!.harness, [el.dataset.harness]: el.value };
      if (el.value === "spacexai") {
        harness.baseUrl = "https://api.x.ai/v1";
        harness.apiKeyEnv = "XAI_API_KEY";
      }
      await api("/api/settings", { method: "PUT", body: { harness } });
      await refreshSettings();
    }
    if (el.dataset.harnessText) {
      const tab = state.harnessTab || state.settings?.harness?.provider;
      if (tab === "hermes" && el.dataset.harnessText === "model") {
        await api("/api/harness/hermes", { method: "PUT", body: { model: el.value } });
        if (state.harnessStatus?.harnesses?.hermes) state.harnessStatus.harnesses.hermes.model = el.value;
        await loadHarnessStatus();
        paintModal();
        return;
      }
      // EVERY field, not just `model`. Settings.harness is ONE flat record --
      // one provider, one baseUrl, one apiKey -- so writing a key typed on a
      // non-default tab spread it over the default provider's record, leaving
      // provider/baseUrl untouched. The next turn, and the Test button right
      // beside the field, then sent that key to the OTHER provider's endpoint:
      // an OpenAI key shipped to api.x.ai as a bearer token. On a spacexai
      // default it also destroyed the stored xAI key. The panel already tells
      // the user this tab is not active; now it genuinely is not.
      if (tab && tab !== (state.settings?.harness?.provider || "grok-build")) {
        return;
      }
      const harness = { ...state.settings!.harness, [el.dataset.harnessText]: el.value };
      await api("/api/settings", { method: "PUT", body: { harness } });
      await refreshSettings();
    }
    if (el.id === "bot-color-pick") {
      const bot = editorBot();
      if (bot && el.value && !isLiveCloud()) {
        bot.color = el.value;
        persistEditorBot(bot, { color: bot.color });
        refreshAvatars();
      }
    }
    if (el.id === "ch") {
      snapshotCreateForm();
      state.createHarness = el.value;
      state.createModel = pickModelForProvider(el.value, state.createModel);
      rebuildCreateModal();
    }
    if (el.id === "cm") {
      state.createModel = el.value;
    }
    if (el.id === "bh") {
      const bot = editorBot();
      if (isLiveCloud()) {
        if (bot) {
          const host = $("#bot-editor");
          if (host) delete host.dataset.bot;
          paintBotEditor(bot);
        }
        return;
      }
      if (bot) {
        const provider = el.value;
        const prev = bot.harness?.model || "";
        bot.harness = {
          ...(bot.harness || {}),
          provider,
          model: pickModelForProvider(provider, prev),
        };
        const host = $("#bot-editor");
        if (host) delete host.dataset.bot;
        paintBotEditor(bot);
      }
    }
    if (el.id === "bm") {
      const bot = editorBot();
      if (isLiveCloud()) {
        if (bot) {
          const host = $("#bot-editor");
          if (host) delete host.dataset.bot;
          paintBotEditor(bot);
        }
        return;
      }
      if (bot) bot.harness = { ...(bot.harness || {}), model: el.value };
    }
    if (el.dataset.computerName) {
      const id = el.dataset.computerName;
      const name = el.value.trim();
      if (!name) return;
      api(`/api/computers/${id}`, { method: "PATCH", body: { name } }).then(() => loadComputers());
    }
    if (el.dataset.computerSort != null || el.classList.contains("csort")) {
      state.computerSort = el.value || "name";
      try {
        localStorage.setItem("sub8.computerSort", state.computerSort);
      } catch {
        /* ignore */
      }
      paintModal();
    }
  });
  document.addEventListener("click", async (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tog]");
    if (!el) return;
    const key = el.dataset.tog as string;
    await api("/api/settings", { method: "PUT", body: { [key]: !state.settings![key] } });
    await refreshSettings();
    render();
  });
}

function restoreIdentitiesModal(): void {
  if (state.modal === "claude-code") {
    state.modal = "settings";
    state.section = "identities";
  }
}

/** GET the desk's Claude login state into `state.claudeAuth`. */
async function loadClaudeAuth(): Promise<void> {
  const desk = cloudDeskIdOf(currentBot());
  if (!isCloudPlace() || !desk) {
    if (!state.claudeAuth?.awaitingCode) state.claudeAuth = null;
    return;
  }
  const pending = state.claudeAuth?.awaitingCode
    ? {
        awaitingCode: true as const,
        signInUrl: state.claudeAuth.signInUrl,
        error: state.claudeAuth.error,
        busy: state.claudeAuth.busy,
      }
    : null;
  try {
    const r = (await api(`/api/cloud/brain/claude/auth?computerId=${encodeURIComponent(desk)}`)) as
      | { loggedIn?: boolean; email?: string; authMethod?: string; raw?: { loggedIn?: boolean; email?: string; authMethod?: string } }
      | null;
    const row = r?.raw || r || {};
    if (row.loggedIn) {
      state.claudeAuth = { loggedIn: true, email: row.email, authMethod: row.authMethod, busy: false, awaitingCode: false };
      restoreIdentitiesModal();
    } else {
      state.claudeAuth = {
        loggedIn: false,
        email: row.email,
        authMethod: row.authMethod,
        ...(pending || {}),
      };
    }
  } catch {
    // A desk with no IP yet answers 409 -- that is "unknown", not "signed out".
    if (!pending) state.claudeAuth = null;
  }
  if (!state.claudeAuth?.awaitingCode) paintModal();
}

async function claudeDeskLogin(): Promise<void> {
  const desk = cloudDeskIdOf(currentBot());
  if (!desk) {
    window.alert("Select a Cloud desk bot first.");
    return;
  }
  state.modal = "claude-code";
  state.claudeAuth = { ...(state.claudeAuth || {}), busy: true, awaitingCode: false, error: "" };
  paintModal();
  try {
    const started = (await api("/api/cloud/brain/claude/auth/start", {
      method: "POST",
      body: { computerId: desk },
    })) as { url?: string; loggedIn?: boolean } | null;
    if (started?.loggedIn) {
      state.claudeAuth = { loggedIn: true, busy: false, awaitingCode: false };
      restoreIdentitiesModal();
      await loadClaudeAuth();
      await loadIdentities();
      return;
    }
    if (!started?.url) throw new Error("The desk did not return a sign-in link.");
    openExternal(started.url);
    state.modal = "claude-code";
    state.claudeAuth = {
      loggedIn: false,
      busy: false,
      awaitingCode: true,
      signInUrl: started.url,
      error: "",
    };
    paintModal();
  } catch (err) {
    state.modal = "claude-code";
    state.claudeAuth = {
      ...(state.claudeAuth || {}),
      busy: false,
      awaitingCode: true,
      error: (err as CaughtError | undefined)?.message || "Could not sign this desk in to Claude.",
    };
    paintModal();
  }
}

async function claudeDeskSubmitCode(): Promise<void> {
  const desk = cloudDeskIdOf(currentBot());
  if (!desk) return;
  const code = ($<HTMLInputElement>("#claude-auth-code")?.value || "").trim();
  if (!code) {
    state.claudeAuth = { ...(state.claudeAuth || {}), error: "Paste the code from claude.com." };
    paintModal();
    return;
  }
  state.claudeAuth = { ...(state.claudeAuth || {}), busy: true, error: "" };
  paintModal();
  try {
    await api("/api/cloud/brain/claude/auth/code", { method: "POST", body: { computerId: desk, code } });
    state.claudeAuth = { loggedIn: true, busy: false, awaitingCode: false };
    restoreIdentitiesModal();
    await loadClaudeAuth();
    await loadIdentities();
  } catch (err) {
    state.claudeAuth = {
      ...(state.claudeAuth || {}),
      busy: false,
      awaitingCode: true,
      error: (err as CaughtError | undefined)?.message || "That code did not work. Try again.",
    };
    paintModal();
  }
}

async function claudeDeskLoginCancel(): Promise<void> {
  const desk = cloudDeskIdOf(currentBot());
  state.claudeAuth = { loggedIn: false, busy: false, awaitingCode: false, error: "" };
  restoreIdentitiesModal();
  if (desk) {
    await api("/api/cloud/brain/claude/auth/logout", { method: "POST", body: { computerId: desk } }).catch(() => null);
  }
  await loadClaudeAuth();
  await loadIdentities();
}

async function claudeDeskLogout(): Promise<void> {
  const desk = cloudDeskIdOf(currentBot());
  if (!desk) return;
  state.claudeAuth = { ...(state.claudeAuth || {}), busy: true };
  paintModal();
  try {
    await api("/api/cloud/brain/claude/auth/logout", { method: "POST", body: { computerId: desk } });
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not sign this desk out.");
  }
  await loadClaudeAuth();
  await loadIdentities();
}

async function startGrokOAuth(): Promise<void> {
  const note = $("#harness-ping");
  if (note) note.textContent = "Signing in…";
  try {
    const r = await api("/api/harness/grok-login", { method: "POST", body: { botId: state.selected } }) as GrokLogin;
    if (note) note.textContent = r.message || (r.reused ? "Reused this Mac’s Grok session." : "Sign-in started.");
    if (r.reused && !r.needHostLogin) {
      state.hasGrokAuth = true;
      state.grokAuthAsk = false;
      paintGrokAuth();
    }
    if (r.needHostLogin && !state.hasGrokAuth) {
      state.grokAuthAsk = false;
      if (!state.brainSetup) openBrainSetup();
      paintGrokAuth();
      const end = Date.now() + 180_000;
      const poll = async () => {
        if (Date.now() > end) return;
        try {
          const again = await api("/api/harness/grok-login", { method: "POST", body: { botId: state.selected } }) as GrokLogin;
          if (again.reused && !again.needHostLogin) {
            if (note) note.textContent = again.message || "Signed in.";
            state.hasGrokAuth = true;
            state.grokAuthAsk = false;
            paintGrokAuth();
            return;
          }
        } catch {
          /* keep polling */
        }
        setTimeout(poll, 3000);
      };
      poll();
    }
  } catch (err) {
    if (note) note.textContent = `OAuth failed · ${(err as CaughtError).message}`;
  }
}

async function testHarness(provider: string | undefined): Promise<void> {
  const id = provider || state.harnessTab || state.settings?.harness?.provider || "grok-build";
  state.harnessTests[id] = { ...(state.harnessTests[id] || {}), busy: true, note: "Testing…" };
  if (state.modal === "settings" && state.section === "harness") paintModal();
  try {
    const r = await api("/api/harness/test", { method: "POST", body: { botId: state.selected, provider: id } }) as HarnessTestResult;
    const line = r.ok
      ? `OK · ${r.provider || id} · ${r.model || "default"}`
      : `Failed · ${r.error || "no reply"}`;
    state.harnessTests[id] = {
      busy: false,
      note: line,
      log: String(r.log || r.sample || r.error || "").trim() || line,
      ok: Boolean(r.ok),
      at: r.at || Date.now(),
    };
  } catch (err) {
    state.harnessTests[id] = { busy: false, note: `Failed · ${(err as CaughtError).message}`, log: (err as CaughtError).message, ok: false };
  }
  if (state.modal === "settings" && state.section === "harness") paintModal();
}

function setupQuery(): URLSearchParams {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

async function loadIdentities(): Promise<void> {
  try {
    const desk = isCloudPlace() ? cloudDeskIdOf(currentBot()) : "";
    const url = desk ? `/api/identities?computerId=${encodeURIComponent(desk)}` : "/api/identities";
    const data = await api(url) as { identities?: IdentityRow[]; catalog?: { id: string; label: string }[] };
    state.identities = data.identities || [];
    state.identityCatalog = data.catalog || [];
  } catch {
    state.identities = state.identities || [];
  }
}

async function loadHarnessStatus(): Promise<HarnessStatusFull | null> {
  try {
    const sim = setupQuery().get("simulate") || (setupQuery().get("setup") === "1" ? "none" : "");
    const url = sim ? `/api/harness/status?simulate=${encodeURIComponent(sim)}` : "/api/harness/status";
    state.harnessStatus = await api(url) as HarnessStatusFull;
    if (state.harnessStatus?.local) state.localHarness = { ...state.localHarness, ...state.harnessStatus.local };
    paintHarnessBanner();
    return state.harnessStatus;
  } catch {
    return null;
  }
}

let teachTimer: number | null = null;

function stopTeachCapture(): void {
  if (teachTimer) {
    clearInterval(teachTimer);
    teachTimer = null;
  }
}

function imageAtLeast(dataUrl: string, min: number): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width >= min && img.height >= min);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    // readAsDataURL always lands a string in .result.
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function startTeachCapture(botId: string | null): void {
  stopTeachCapture();
  const grab = async () => {
    if (state.teach !== "recording" || !botId) return;
    try {
      const res = await fetch(`/api/bots/${botId}/screen?t=${Date.now()}`);
      if (!res.ok) return;
      const url = await blobToDataUrl(await res.blob());
      state.teachFrames.push(url);
      if (state.teachFrames.length > 16) state.teachFrames.shift();
    } catch {
      /* ignore */
    }
  };
  grab();
  teachTimer = setInterval(grab, 2000);
}

async function finishTeach(): Promise<void> {
  const bot = state.bots.find((b) => b.id === state.selected);
  const frames = [...state.teachFrames];
  state.teach = null;
  state.teachFrames = [];
  state.deskSize = "side";
  render();
  if (!bot) return;
  const name = `Taught task ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  bot.busy = true;
  // adoptBot() seeds .messages on every bot in state.bots.
  bot.messages!.push({
    id: `pending-${Date.now()}`,
    role: "user",
    content: `Learn this task I just demonstrated (${name}).`,
    ts: Date.now(),
  });
  paintChat(bot);
  try {
    await api(`/api/bots/${bot.id}/teach`, { method: "POST", body: { name, frames } });
  } catch (err) {
    bot.busy = false;
    bot.messages!.push({
      id: `e${Date.now()}`,
      role: "assistant",
      content: `Couldn’t save that task: ${(err as CaughtError).message}`,
      ts: Date.now(),
    });
    paintChat(bot);
  }
}

async function onAttachFiles(e: Event): Promise<void> {
  // Only #attach-file fires this, and that is an <input type="file">.
  const files = [...((e.target as HTMLInputElement).files || [])];
  (e.target as HTMLInputElement).value = "";
  for (const file of files) {
    const item = { name: file.name, type: file.type || "file", dataUrl: "", text: "" };
    if (file.type.startsWith("image/")) {
      item.dataUrl = await blobToDataUrl(file);
      const big = await imageAtLeast(item.dataUrl, 8);
      if (!big) {
        item.text = `(skipped ${file.name}: image must be at least 8×8)`;
        item.dataUrl = "";
      }
    } else if (file.size < 80_000) {
      item.text = await file.text();
    }
    state.attachments.push(item);
  }
  render();
}

let dictateCtl: { stop: () => void } | null = null;

function setMicUI(on: boolean, err?: string): void {
  const btn = $(".composer-mic");
  const input = $<SendForm>("#send")?.q;
  if (btn) {
    btn.classList.toggle("on", on);
    btn.title = on ? "Stop listening" : "Speak";
  }
  if (input && err) input.placeholder = err;
  else if (input && state.selected) {
    const bot = state.bots.find((b) => b.id === state.selected);
    if (on) input.placeholder = "Listening… click the mic when you’re done";
    else if (bot) input.placeholder = `Message ${bot.name}`;
  }
}


async function toggleDictate(): Promise<void> {
  if (dictateCtl) {
    dictateCtl.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    setMicUI(false, "Allow Microphone for Sub8 in System Settings → Privacy.");
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    dictateCtl = null;
    if (rec.state !== "inactive") rec.stop();
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const input = $<SendForm>("#send")?.q;
    if (blob.size < 2000) {
      setMicUI(false, "That was too short. Click mic, talk, click mic again.");
      return;
    }
    if (input) input.placeholder = "Transcribing…";
    try {
      const res = await fetch("/api/dictate", {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: await blob.arrayBuffer(),
      });
      const data = await res.json().catch(() => ({}));
      if (data.text && input) {
        input.value = `${input.value}${input.value ? " " : ""}${data.text}`.trim();
        input.focus();
        setMicUI(false);
      } else {
        setMicUI(false, data.error || "Couldn’t transcribe that. Try again.");
      }
    } catch (err) {
      setMicUI(false, (err as CaughtError).message || "Dictate failed.");
    }
  };
  rec.start(200);
  dictateCtl = { stop: finish };
  setMicUI(true);
  setTimeout(() => dictateCtl?.stop(), 30_000);
}

function sizeComposer(): void {
  const ta = $<SendForm>("#send")?.q;
  if (!ta || ta.tagName !== "TEXTAREA") return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
}

function onComposerKey(e: KeyboardEvent): void {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return;
  e.preventDefault();
  $<SendForm>("#send")?.requestSubmit?.() || $<SendForm>("#send")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

function typedChoiceAnswer(): { messageId: string; text: string } | null {
  for (const el of document.querySelectorAll<HTMLInputElement>(".choice-custom")) {
    const text = String(el.value || "").trim();
    if (el.dataset.mid && text) return { messageId: el.dataset.mid, text };
  }
  return null;
}

async function onSend(e: ComposerSubmit): Promise<void> {
  e.preventDefault();
  const input = (e.target as SendForm).q;
  const bot = currentBot();
  if (isCloudPlace() && !cloudDeskReady(bot)) return;
  const text = input?.value?.trim() || "";
  const files = state.attachments;
  const typed = typedChoiceAnswer();
  if (!files.length && typed && !text) {
    await submitChoice(typed.messageId, "custom", typed.text);
    return;
  }
  if ((!text && !files.length) || !activeBotId()) return;
  input.value = "";
  state.attachments = [];
  state.chatFollow = true;
  sizeComposer();
  const images = files.filter((f) => f.dataUrl).map((f) => f.dataUrl);
  const extras = files
    .filter((f) => f.text)
    .map((f) => `\n\nAttached ${f.name}:\n${f.text.slice(0, 4000)}`)
    .join("");
  const names = files.map((f) => f.name).join(", ");
  const content = [text, names && !text ? `Attached ${names}` : names && text ? `(attached ${names})` : "", extras]
    .filter(Boolean)
    .join(" ");
  const team = isCloudPlace() ? null : teamOf(bot);
  const members = teamBots(team);
  const toIds = mentionedMemberIds(content, members);
  if (bot) {
    bot.busy = true;
    bot.messages!.push({
      id: `pending-${Date.now()}`,
      role: "user",
      content,
      ts: Date.now(),
      speakerId: "user",
      speakerName: "You",
    });
    paintChat(bot);
    refreshAvatars();
  }
  if (isCloudPlace()) {
    try {
      // activeBotId() answered above, so currentBot() found a bot.
      const computerId = bot!.computerId || bot!.vm?.computerId;
      const snap = await api(`/api/cloud/draft/bots/${bot!.id}/messages`, {
        method: "POST",
        body: {
          computerId,
          botId: bot!.id,
          content,
          identityId: workerCloudIdentityId(bot!.identityId || ""),
        },
      }) as CloudDraftState;
      state.cloudDraft = snap;
      const live = currentBot();
      if (live) live.busy = true;
      render();
      const userMessage = snap.userMessage || snap.reply?.userMessage;
      const turnId = snap.turnId || snap.reply?.turnId;
      if (turnId) cloudTurns.set(bot!.id, { turnId, computerId });
      watchCloudTurn(bot!.id, content, userMessage?.id, { turnId, computerId });
    } catch (err) {
      if (bot) bot.busy = false;
      if ((err as CaughtError).code === "NEED_BRAIN" || /connect a brain/i.test((err as CaughtError).message || "")) {
        render();
        return;
      }
      if (bot) {
        bot.messages!.push({
          id: `err-${Date.now()}`,
          role: "assistant",
          content: (err as CaughtError).message || "Cloud chat failed.",
          ts: Date.now(),
        });
      }
      render();
    }
    return;
  }
  // The composer was cleared and an optimistic bubble pushed BEFORE this
  // await, and onSend is attached raw as the submit listener -- so a failed
  // POST (server restarting, machine offline, a 500 out of patchBot) became an
  // unhandled rejection: the typed text was gone, a pending bubble the server
  // had never seen sat in the thread, and the bot stayed pinned at "Working…"
  // with nothing scheduled to clear it. The Cloud branch above already
  // handles this; the local path was the outlier.
  try {
    if (team && toIds.length) {
      await api(`/api/teams/${team.id}/messages`, { method: "POST", body: { content, images, toIds } });
      return;
    }
    await api(`/api/bots/${bot!.id}/messages`, { method: "POST", body: { content, images } });
  } catch (err) {
    if (bot) {
      bot.busy = false;
      bot.messages = (bot.messages || []).filter((m) => !String(m.id || "").startsWith("pending-"));
      bot.messages.push({
        id: `err-${Date.now()}`,
        role: "assistant",
        content: `Could not send that: ${(err as CaughtError).message || "the app server did not answer."}`,
        ts: Date.now(),
      });
    }
    // Give the text back rather than losing it.
    if (input && !input.value) {
      input.value = text;
      sizeComposer();
    }
    render();
  }
}

async function watchCloudTurn(botId: string, userText: string, messageId: string | undefined, { turnId, computerId }: { turnId?: string | undefined; computerId?: string | undefined } = {}): Promise<void> {
  const gen = ++cloudWatchGen;
  const started = Date.now();
  const wantId = String(messageId || "").trim();
  const needle = String(userText || "").trim();
  while (Date.now() - started < 600000 && isCloudPlace() && gen === cloudWatchGen) {
    await new Promise((r) => setTimeout(r, 1200));
    if (turnId && computerId) {
      try {
        const st = await api(
          `/api/cloud/brain/turn?computerId=${encodeURIComponent(computerId)}&id=${encodeURIComponent(turnId)}`,
        ) as { status?: string } | null;
        if (st?.status === "done" || st?.status === "error" || st?.status === "aborted") {
          await loadCloudDraft().catch(() => {});
          const bot = (state.cloudDraft?.bots || []).find((b) => b.id === botId) || currentBot();
          if (bot) bot.busy = false;
          cloudTurns.delete(botId);
          render();
          return;
        }
      } catch {
        /* snapshot fallback below */
      }
    }
    try {
      await loadCloudDraft();
    } catch {
      /* keep polling */
    }
    const bot = (state.cloudDraft?.bots || []).find((b) => b.id === botId) || currentBot();
    if (!bot) break;
    const msgs = bot.messages || [];
    // Every index below came from msgs.map((m, i) => i), so it is in bounds.
    const userAt = wantId
      ? [...msgs].map((m, i) => i).reverse().find((i) => String(msgs[i]!.id || "") === wantId)
      : [...msgs]
          .map((m, i) => i)
          .reverse()
          .find((i) => msgs[i]!.role === "user" && String(msgs[i]!.content || "").trim() === needle);
    const last = msgs.at(-1);
    if (Number.isInteger(userAt) && last?.role === "assistant" && last.ts! >= (msgs[userAt!]!.ts || 0)) {
      bot.busy = false;
      cloudTurns.delete(botId);
      render();
      return;
    }
    bot.busy = true;
    if ($("#thread")) paintChat(bot);
  }
  if (gen !== cloudWatchGen) return;
  const bot = (state.cloudDraft?.bots || []).find((b) => b.id === botId) || currentBot();
  if (bot) {
    bot.busy = false;
    if ($("#thread")) paintChat(bot);
  }
}

function mentionedMemberIds(text: string, members: Bot[] | null | undefined): string[] {
  // One capture group, so every match carries m[1].
  const tags = [...String(text || "").matchAll(/@([^\s@.,!?]+)/g)].map((m) => m[1]!.toLowerCase());
  if (!tags.length) return [];
  const ids = [];
  for (const m of members || []) {
    const name = String(m.name || "").toLowerCase();
    const role = String(m.teamRole || m.role || "").toLowerCase();
    if (tags.some((t) => t === name || t === role || (name && name.startsWith(t)))) ids.push(m.id);
  }
  return [...new Set(ids)];
}

const choiceBusy = new Set<string>();

async function submitChoice(messageId: string | undefined, choiceId: string | undefined, custom: string): Promise<void> {
  if (isCloudPlace()) {
    const bot = currentBot();
    if (!bot || !messageId) return;
    const card = (bot.messages || []).find((m) => m.id === messageId);
    const label = custom || card?.choices?.find((c) => String(c.id) === String(choiceId))?.label || choiceId;
    if (card) {
      card.pending = false;
      card.selected = { id: choiceId || "custom", label };
    }
    const form = $<SendForm>("#send");
    const q = form?.q;
    if (q) q.value = `Picked: ${label}`;
    // A real submit event carries the form as its target, and onSend reads
    // e.target.q straight away. Passing only preventDefault threw
    // "Cannot read properties of undefined (reading 'q')" here, so picking a
    // choice in the Cloud place raised an unhandled rejection and never sent.
    await onSend({ preventDefault() {}, target: form });
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || !messageId) return;
  const busyKey = `${bot.id}:${messageId}`;
  if (choiceBusy.has(busyKey)) return;
  choiceBusy.add(busyKey);
  const card = (bot.messages || []).find((m) => m.id === messageId);
  if (card) {
    card.pending = false;
    card.selected = { id: choiceId || "custom", label: custom || card.choices?.find((c) => String(c.id) === String(choiceId))?.label || "" };
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  paintChat(bot);
  try {
    const r = await api(`/api/bots/${bot.id}/choice`, {
      method: "POST",
      body: { messageId, choiceId, custom },
    }) as { created?: boolean } | null;
    if (r?.created) await refresh();
    else await loadBotHistory(bot.id);
  } catch (err) {
    const live = (state.bots.find((b) => b.id === bot.id)?.messages || []).find((m) => m.id === messageId);
    if (/choice is not open/i.test((err as CaughtError | undefined)?.message || "") && live?.selected) {
      live.pending = false;
      paintChat(state.bots.find((b) => b.id === bot.id) || bot);
      return;
    }
    if (card) card.pending = true;
    window.alert((err as CaughtError | undefined)?.message || "Could not save that choice.");
    paintChat(bot);
  } finally {
    choiceBusy.delete(busyKey);
  }
}


async function openVault(): Promise<void> {
  try {
    state.vault = await api("/api/vault") as VaultSnapshot;
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not open the vault.");
    return;
  }
  state.modal = "vault";
  state.vaultReveal = false;
  state.vaultNaming = false;
  state.vaultShareOpen = false;
  state.vaultQuery = "";
  const accs = vaultAccountsInView();
  if (!state.vaultEditId || (state.vaultEditId !== "new" && !accs.some((a) => a.id === state.vaultEditId))) {
    state.vaultEditId = accs[0]?.id || null;
  }
  state.vaultShare = botsSharingAccount(state.vaultEditId);
  state.vaultSharePacks = [];
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function addVaultGroup(): Promise<void> {
  const name = ($<HTMLInputElement>("#vault-group-name")?.value || "").trim();
  if (!name) {
    $<HTMLInputElement>("#vault-group-name")?.focus();
    return;
  }
  try {
    const g = await api("/api/vault/groups", { method: "POST", body: { name } }) as VaultGroup | null;
    state.vault = await api("/api/vault") as VaultSnapshot;
    if (g?.id) state.vaultGroup = g.id;
    else {
      const last = (state.vault.groups || []).at(-1);
      if (last) state.vaultGroup = last.id;
    }
    state.vaultNaming = false;
    state.vaultEditId = null;
    const host = $("#modal-host");
    if (host) delete host.dataset.key;
    render();
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not create the group.");
    $<HTMLInputElement>("#vault-group-name")?.focus();
  }
}

function toggleVaultReveal(): void {
  const input = $<HTMLInputElement>("#v-pass");
  const isNew = state.vaultEditId === "new";
  if (!isNew && !state.vaultReveal && input && input.value === "••••") {
    api(`/api/vault/accounts/${state.vaultEditId}/reveal`)
      .then((acc) => {
        state.vaultReveal = true;
        if (input) {
          input.type = "text";
          input.value = (acc as VaultAccount).password || "";
        }
      })
      .catch((err) => window.alert((err as CaughtError | undefined)?.message || "Could not reveal."));
    return;
  }
  state.vaultReveal = !state.vaultReveal;
  if (input) input.type = state.vaultReveal ? "text" : "password";
}

function flushVaultDraft(): void {
  if (state.modal !== "vault") return;
  if (!state.vaultEditId || state.vaultEditId === "new") return;
  if (!$<ValueEl>("#v-label")) return;
  saveVaultAccount({
    quiet: true,
    editId: state.vaultEditId,
    share: [...(state.vaultShare || [])],
  }).catch(() => {});
}

async function persistVaultShare(): Promise<void> {
  const accountId = state.vaultEditId;
  const botIds = [...(state.vaultShare || [])];
  if (!accountId || accountId === "new") return;
  try {
    const snap = await api(`/api/vault/accounts/${accountId}/grants`, { method: "PUT", body: { botIds } }) as VaultSnapshot | null;
    if (snap?.grants) state.vault.grants = snap.grants;
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not update sharing.");
  }
}

async function saveVaultAccount({ quiet = false, editId = state.vaultEditId, share = state.vaultShare }: { quiet?: boolean; editId?: string | null; share?: string[] } = {}): Promise<VaultAccount | null> {
  const body: Record<string, string> = {
    label: $<ValueEl>("#v-label")?.value || "",
    site: $<ValueEl>("#v-site")?.value || "",
    username: $<ValueEl>("#v-user")?.value || "",
    notes: $<ValueEl>("#v-notes")?.value || "",
    groupId: $<ValueEl>("#v-group")?.value || "",
  };
  const pass = $<HTMLInputElement>("#v-pass")?.value;
  if (pass && pass !== "••••") body.password = pass;
  if (editId === "new" && !body.label!.trim() && !body.site!.trim() && !body.username!.trim()) {
    if (!quiet) window.alert("Add a name, username, or website.");
    return null;
  }
  const botIds = [...(share || [])];
  let acc: VaultAccount;
  try {
    if (editId && editId !== "new") {
      acc = await api(`/api/vault/accounts/${editId}`, { method: "PATCH", body }) as VaultAccount;
    } else {
      acc = await api("/api/vault/accounts", { method: "POST", body }) as VaultAccount;
    }
    const snap = await api(`/api/vault/accounts/${acc.id}/grants`, { method: "PUT", body: { botIds } }) as VaultSnapshot | null;
    if (snap?.grants) state.vault.grants = snap.grants;
  } catch (err) {
    if (!quiet) window.alert((err as CaughtError | undefined)?.message || "Could not save the login.");
    return null;
  }
  state.vault = await api("/api/vault") as VaultSnapshot;
  if (quiet) return acc;
  state.vaultEditId = acc.id;
  state.vaultReveal = false;
  state.vaultShare = botsSharingAccount(acc.id);
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
  return acc;
}

async function deleteVaultAccount(id: string | undefined): Promise<void> {
  if (!id || !window.confirm("Delete this login? Bots will lose access.")) return;
  state.vault = await api(`/api/vault/accounts/${id}`, { method: "DELETE" }) as VaultSnapshot;
  state.vaultEditId = null;
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function exportVaultBackup(): Promise<void> {
  try {
    const backup = await api("/api/vault/export");
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sub8-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not export the vault.");
  }
}

async function importVaultBackup(file: File): Promise<void> {
  let payload: { accounts?: unknown[]; groups?: unknown[]; kind?: string };
  try {
    payload = JSON.parse(await file.text());
  } catch {
    window.alert("That file is not valid JSON.");
    return;
  }
  const n = Array.isArray(payload.accounts) ? payload.accounts.length : 0;
  const g = Array.isArray(payload.groups) ? payload.groups.length : 0;
  const ok = window.confirm(
    `Replace all passwords, groups, and sharing with this backup (${n} login${n === 1 ? "" : "s"}, ${g} group${g === 1 ? "" : "s"})? The file contains secrets in plaintext.`,
  );
  if (!ok) return;
  try {
    state.vault = await api("/api/vault/import", {
      method: "POST",
      body: { ...payload, mode: "replace" },
    }) as VaultSnapshot;
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not import the vault.");
    return;
  }
  state.vaultGroup = "all";
  state.vaultReveal = false;
  state.vaultShareOpen = false;
  state.vaultQuery = "";
  const accs = vaultAccountsInView();
  state.vaultEditId = accs[0]?.id || null;
  state.vaultShare = botsSharingAccount(state.vaultEditId);
  state.vaultSharePacks = [];
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function confirmCreateTeam(): Promise<void> {
  const name = ($<ValueEl>("#tn")?.value || state.createName || "").trim() || "Team";
  const provider = $<ValueEl>("#th")?.value || state.createHarness || "claude";
  const btn = $<HTMLButtonElement>("#confirm-create-team");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating…";
  }
  try {
    const team = await api("/api/teams", {
      method: "POST",
      body: {
        name,
        harness: { provider, model: isCliHost(provider) ? (provider === "cursor" ? "cursor-grok-4.6-low" : "default") : "" },
      },
    }) as Team;
    state.modal = null;
    state.teams = [...(state.teams || []).filter((t) => t.id !== team.id), team];
    const chief = team.members?.find((m) => m.role === "chief") || team.members?.[0];
    if (chief) {
      rememberSelected(chief.id);
    }
    await refresh();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create chief + worker";
    }
    window.alert((err as CaughtError | undefined)?.message || "Could not create the team.");
  }
}

async function confirmCreateBot(): Promise<void> {
  snapshotCreateForm();
  const name = (state.createName || "").trim() || "New Bot";
  const description = (state.createDesc || "").trim();
  if (isLiveCloud()) {
    if (state.createCloudKind !== "mate") {
      confirmCreateCloudDesk();
      return;
    }
    const desk = currentBot()?.computerId || currentBot()?.vm?.computerId || viewComputers().find((c) => c.status === "assigned")?.id;
    const btn = $<HTMLButtonElement>("#confirm-create");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Adding…";
    }
    try {
      const snap = await api("/api/cloud/draft/bots", {
        method: "POST",
        body: { computerId: desk, name, job: description, description },
      }) as CloudDraftState;
      state.cloudDraft = snap;
      resetCreateForm();
      if (snap.bot?.id) rememberSelected(snap.bot.id);
      state.modal = null;
      render();
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add teammate";
      }
      if ((err as CaughtError | undefined)?.code === "NEED_DESK") {
        state.createCloudKind = "bot";
        state.createCloudPay = false;
        rebuildCreateModal();
        loadCloudBilling();
        return;
      }
      window.alert((err as CaughtError | undefined)?.message || "Could not add the teammate.");
    }
    return;
  }
  const face = randomCreateFace();
  const provider = state.createHarness || "default";
  const model = (state.createModel || "").trim();
  const harness: BotHarness = { provider };
  if (model) harness.model = model;
  const btn = $<HTMLButtonElement>("#confirm-create");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating…";
  }
  try {
    if (isCloudPlace()) {
      const snap = await api("/api/cloud/draft/bots", {
        method: "POST",
        body: {
          name,
          description,
          avatar: defaultAvatar({ expression: face, animation: "idle" }),
          harness,
        },
      }) as CloudDraftState;
      state.cloudDraft = snap;
      const bot = snap.bot;
      resetCreateForm();
      rememberSelected(bot!.id);
      state.modal = null;
      render();
      return;
    }
    const bot = await api("/api/bots", {
      method: "POST",
      body: {
        name,
        description,
        avatar: defaultAvatar({ expression: face, animation: "idle" }),
        harness,
      },
    }) as Bot;
    resetCreateForm();
    rememberSelected(bot.id);
    state.modal = null;
    await refresh();
    const live = state.bots.find((b) => b.id === bot.id) || bot;
    if (live && !live.vm?.detached) {
      if (!live.vm?.status || live.vm.status === "idle") {
        live.vm = { ...(live.vm || {}), status: "starting", hint: "Starting the computer…" };
      }
      attachLiveFrame(live);
      if (!live.vm?.novncPort && live.vm?.status !== "starting") resumeVm().catch(() => {});
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create Bot";
    }
    window.alert((err as CaughtError | undefined)?.message || "Could not create the bot.");
  }
}

// Cloud routines carry no schedule/trigger list — the Worker cron only knows an
// interval — so save the interval and say so plainly if the picked cadence
// cannot be expressed, rather than silently storing a different meaning.
async function persistCloudRoutine({ bot, name, instruction, close, quiet }: { bot: Bot; name: string; instruction: string; close: boolean; quiet: boolean }): Promise<Routine | null> {
  const computerId = cloudDeskIdOf(bot);
  if (!computerId) return null;
  const intervalMinutes = cloudIntervalFromTriggers(state.routineTriggers);
  if (!intervalMinutes) {
    if (!quiet) window.alert("Cloud routines run on an interval. Pick “every N minutes” or “every hour”.");
    return null;
  }
  const id = state.editingRoutineId;
  // The ternary has just proved the element is there.
  const enabled = $("#re-tog") ? $("#re-tog")!.classList.contains("on") : true;
  try {
    const out = id
      ? await api("/api/cloud/brain/routines", {
          method: "PATCH",
          body: { computerId, id, name, instruction, intervalMinutes, enabled },
        }) as { routine?: Routine } | null
      : await api("/api/cloud/brain/routines", {
          method: "POST",
          body: { computerId, name, instruction, intervalMinutes, botId: bot.id },
        }) as { routine?: Routine } | null;
    const saved = out?.routine || null;
    if (saved?.id) state.editingRoutineId = saved.id;
    if (close) {
      state.modal = null;
      state.editingRoutineId = null;
      state.schedPop = null;
    }
    await loadCloudRoutines(bot, { force: true });
    // Autosave fires while the editor is open, so only a closing save may
    // re-render — a full render mid-edit would rebuild the form and drop focus.
    if (close) render();
    else paintRoutineList(bot);
    return saved;
  } catch (err) {
    if (!quiet) window.alert((err as CaughtError | undefined)?.message || "Could not save the routine.");
    return null;
  }
}

async function persistRoutine({ close = false, quiet = !close }: { close?: boolean; quiet?: boolean } = {}): Promise<Routine | null> {
  const bot = isCloudPlace() ? currentBot() : state.bots.find((b) => b.id === state.selected);
  if (!bot) return null;
  const instruction = ($<ValueEl>("#ri")?.value || "").trim();
  const name = ($<ValueEl>("#rn")?.value || "").trim() || "Routine";
  if (!instruction) {
    if (!quiet) window.alert("Add an instruction before saving this job.");
    return null;
  }
  if (isCloudPlace()) return persistCloudRoutine({ bot, name, instruction, close, quiet });
  // Same predicate again: filter(Boolean) drops only the nulls.
  let triggers = (state.routineTriggers || []).map(normalizeClientTrigger).filter(Boolean) as Trigger[];
  if (!triggers.length) {
    triggers = [{ id: newTriggerId(), kind: "interval", intervalMs: 2 * 3600_000 }];
    state.routineTriggers = triggers;
    paintRoutineWhen();
  }
  const body: Record<string, unknown> = {
    name,
    instruction,
    enabled: $("#re-tog") ? $("#re-tog")!.classList.contains("on") : true,
    triggers,
  };
  try {
    if (state.editingRoutineId) {
      const saved = await api(`/api/bots/${bot.id}/routines/${state.editingRoutineId}`, { method: "PATCH", body }) as Routine | null;
      const live = bot.routines?.find((x) => x.id === state.editingRoutineId);
      if (live && saved) Object.assign(live, saved);
      if (close) {
        state.modal = null;
        state.editingRoutineId = null;
        state.schedPop = null;
      }
      if (close) await refresh();
      else paintRoutineList(bot);
      return saved;
    }
    body.force_new = true;
    body.solo = false;
    const result = await api(`/api/bots/${bot.id}/routines`, { method: "POST", body }) as { routine?: Routine } & Routine;
    const created = result?.routine || result;
    if (created?.id) state.editingRoutineId = created.id;
    if (close) {
      state.modal = null;
      state.editingRoutineId = null;
      state.schedPop = null;
    }
    await refresh();
    if (!close && state.modal === "routine") {
      paintRoutineWhen();
    }
    return created;
  } catch (err) {
    if (!quiet) window.alert((err as CaughtError | undefined)?.message || "Could not save the routine.");
    return null;
  }
}

async function testRoutine(): Promise<void> {
  // No Cloud equivalent — the Worker cron has no on-demand run endpoint, and
  // state.selected still points at a local bot while the Cloud place is open.
  if (isCloudPlace()) return;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  const saved = await persistRoutine({ close: false, quiet: false });
  const id = saved?.id || state.editingRoutineId;
  if (!id) return;
  try {
    await api(`/api/bots/${bot.id}/routines/${id}/run`, { method: "POST" });
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not start a test run.");
    return;
  }
  state.modal = null;
  state.editingRoutineId = null;
  state.schedPop = null;
  await refresh();
}


async function deleteRoutine(id: string | null | undefined): Promise<void> {
  if (isCloudPlace()) {
    const bot = currentBot();
    const computerId = cloudDeskIdOf(bot);
    if (!computerId || !id) return;
    if (state.editingRoutineId === id) {
      state.editingRoutineId = null;
      state.modal = null;
    }
    try {
      await api("/api/cloud/brain/routines", { method: "DELETE", body: { computerId, id } });
    } catch (err) {
      window.alert((err as CaughtError | undefined)?.message || "Could not delete the routine.");
    }
    await loadCloudRoutines(bot, { force: true });
    render();
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || !id) return;
  bot.routines = (bot.routines || []).filter((r) => r.id !== id);
  paintRoutineList(bot);
  if (state.editingRoutineId === id) {
    state.editingRoutineId = null;
    state.modal = null;
  }
  try {
    await api(`/api/bots/${bot.id}/routines/${id}`, { method: "DELETE" });
  } catch {
    await refresh();
    return;
  }
  await refresh();
}

async function toggleRoutine(id: string | undefined): Promise<void> {
  if (isCloudPlace()) {
    const bot = currentBot();
    const computerId = cloudDeskIdOf(bot);
    const row = cloudRoutineRows(bot).find((x) => x.id === id);
    if (!computerId || !row) return;
    try {
      await api("/api/cloud/brain/routines", {
        method: "PATCH",
        body: { computerId, id, enabled: row.enabled === false },
      });
    } catch (err) {
      window.alert((err as CaughtError | undefined)?.message || "Could not update the routine.");
    }
    await loadCloudRoutines(bot, { force: true });
    render();
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  const r = (bot?.routines || []).find((x) => x.id === id);
  if (!bot || !r) return;
  await api(`/api/bots/${bot.id}/routines/${id}`, {
    method: "PATCH",
    body: { enabled: r.enabled === false },
  });
  await refresh();
}

async function deleteBot(id: string | null | undefined, keepComputer = true): Promise<void> {
  if (!id) return;
  if (isCloudPlace()) {
    state.confirmDeleteId = null;
    state.deleteBotId = null;
    state.botEdit = false;
    state.modal = null;
    if (isLiveCloud()) {
      const bot = botById(id);
      const deskId = cloudDeskIdOf(bot);
      try {
        if (isCloudChief(bot) && !keepComputer) {
          if (!deskId) throw new Error("No Cloud computer on this bot.");
          state.cloudDraft = await api(`/api/cloud/draft/computers/${deskId}`, { method: "DELETE" }) as CloudDraftState;
        } else if (isCloudChief(bot)) {
          window.alert("The desk bot stays until you destroy the Cloud computer.");
          render();
          return;
        } else {
          state.cloudDraft = await api(`/api/cloud/draft/bots/${id}`, {
            method: "DELETE",
            body: { computerId: deskId },
          }) as CloudDraftState;
        }
        if (state.selectedCloud === id) rememberSelected(viewBots().find((b) => !b.hidden)?.id || null);
        render();
      } catch (err) {
        window.alert((err as CaughtError | undefined)?.message || "Could not delete the bot.");
        render();
      }
      return;
    }
    try {
      const snap = await api(`/api/cloud/draft/bots/${id}`, { method: "DELETE" }) as CloudDraftState;
      state.cloudDraft = snap;
      if (state.selectedCloud === id) rememberSelected(viewBots().find((b) => !b.hidden)?.id || null);
      render();
    } catch (err) {
      window.alert((err as CaughtError | undefined)?.message || "Could not delete the bot.");
    }
    return;
  }
  forgottenBots.add(id);
  state.bots = state.bots.filter((b) => b.id !== id);
  state.confirmDeleteId = null;
  state.deleteBotId = null;
  state.botEdit = false;
  state.modal = null;
  if (state.selected === id) rememberSelected(state.bots.find((b) => !b.hidden)?.id || null);
  render();
  try {
    await api(`/api/bots/${id}`, { method: "DELETE", body: { keepComputer: Boolean(keepComputer) } });
  } catch (err) {
    forgottenBots.delete(id);
    window.alert((err as CaughtError | undefined)?.message || "Could not delete the bot.");
    await refresh();
    return;
  }
  await refresh();
  loadComputers();
}

async function refreshComputerPreviews(): Promise<void> {
  try {
    await api("/api/computers/previews", { method: "POST", body: {} });
    state.previewTick = Date.now();
    if (state.modal === "computers") paintModal();
  } catch {
    /* docker may be busy */
  }
}

async function recoverDocker(): Promise<void> {
  if (state.dockerBusy) return;
  state.dockerBusy = "recover";
  paintDockerGate();
  if (state.modal === "computers" || state.modal === "settings") paintModal();
  try {
    const r = await api("/api/docker/recover", { method: "POST", body: {} }) as DockerActionResult;
    if (r.docker) state.docker = r.docker;
    if (r.log) state.dockerLog = r.log;
    if (Array.isArray(r.computers)) state.computers = r.computers;
    await refresh();
    await loadComputers();
  } catch {
    /* pane already shows the current Docker state */
  } finally {
    state.dockerBusy = false;
    paintDockerGate();
    if (state.modal === "computers" || state.modal === "settings") paintModal();
  }
}

async function installDocker(): Promise<void> {
  if (state.dockerBusy) return;
  if (state.docker?.cli) {
    await recoverDocker();
    return;
  }
  state.dockerBusy = "install";
  state.dockerInstallFailed = false;
  state.dockerLog = state.docker?.installLog || "Installing Docker…";
  paintDockerGate();
  if (state.modal === "computers" || state.modal === "settings") paintModal();
  try {
    const r = await api("/api/docker/install", { method: "POST", body: {} }) as DockerActionResult;
    if (r.docker) state.docker = r.docker;
    if (r.log) state.dockerLog = r.log;
    if (r.hint && r.docker) state.docker!.hint = r.hint;
    if (Array.isArray(r.computers)) state.computers = r.computers;
    state.dockerInstallFailed = !r.ok;
    if (r.ok) {
      await refresh();
      await loadComputers();
    }
  } catch (err) {
    state.dockerInstallFailed = true;
    state.dockerLog = `${state.dockerLog ? `${state.dockerLog}\n` : ""}${(err as CaughtError | undefined)?.message || "Install failed"}`;
    if (state.docker) state.docker.hint = (err as CaughtError | undefined)?.message || "Install failed";
  } finally {
    state.dockerBusy = false;
    paintDockerGate();
    if (state.modal === "computers" || state.modal === "settings") paintModal();
  }
}

async function loadComputers(): Promise<Computer[]> {
  try {
    const r = await api("/api/computers") as { computers?: Computer[]; docker?: DockerState };
    state.computers = r.computers || [];
    if (r.docker) {
      const was = dockerMissing();
      state.docker = r.docker;
      if (was !== dockerMissing()) paintDockerGate();
    }
    if (state.computerId && !state.computers.some((c) => c.id === state.computerId)) {
      state.computerId = state.computers[0]?.id || null;
    }
    if (state.modal === "computers") paintModal();
    const bar = $("#titlebar");
    if (bar) delete bar.dataset.stamp;
    paintTitle(currentBot() || state.bots.find((b) => b.id === state.selected));
    return state.computers;
  } catch {
    return state.computers;
  }
}

function paintComputerStats(): void {
  for (const [name, st] of Object.entries(state.computerStats || {})) {
    document.querySelectorAll<HTMLElement>(`[data-cmem="${CSS.escape(name)}"]`).forEach((el) => {
      const pct = Math.max(0, Math.min(100, Number(st.memPct) || 0));
      const fill = el.querySelector<HTMLElement>("[data-cmem-fill]");
      const lab = el.querySelector<HTMLElement>("[data-cmem-label]");
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle("hot", pct >= 85);
        fill.classList.toggle("warm", pct >= 60 && pct < 85);
        fill.classList.toggle("ok", pct < 60);
      }
      if (lab) lab.textContent = (st.mem || "—").replace(/iB$/i, "B");
    });
  }
}

async function loadComputerStats(): Promise<void> {
  if (state.modal !== "computers") return;
  try {
    const r = await api("/api/computers/stats") as { stats?: Record<string, ComputerStat> };
    state.computerStats = r.stats || {};
    paintComputerStats();
  } catch {
    /* ignore */
  }
}

async function computerAction(id: string | undefined, action: string | undefined, body: Record<string, unknown> = {}): Promise<void> {
  try {
    const r = await api(`/api/computers/${id}/${action}`, { method: "POST", body }) as { computers?: Computer[] };
    state.computers = r.computers || state.computers;
    state.computerAttach = false;
    if (state.modal === "computers") paintModal();
    await refresh();
    loadComputerStats();
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "That computer action failed.");
  }
}

async function loadComputerImages(computerId: string | null | undefined): Promise<void> {
  if (!computerId || isCloudPlace()) {
    state.computerImages = [];
    if (state.modal === "computers") paintModal();
    return;
  }
  try {
    const r = await api(`/api/computers/${computerId}/images`) as { images?: DeskImage[] };
    if (state.computerId !== computerId) return;
    state.computerImages = r.images || [];
    if (state.modal === "computers") paintModal();
  } catch {
    if (state.computerId !== computerId) return;
    state.computerImages = [];
    if (state.modal === "computers") paintModal();
  }
}

async function snapshotDesk(computerId: string | undefined): Promise<void> {
  if (!computerId || state.computerImagesBusy) return;
  state.computerImagesBusy = true;
  if (state.modal === "computers") paintModal();
  try {
    await api(`/api/computers/${computerId}/images`, { method: "POST", body: {} });
    await loadComputerImages(computerId);
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not snapshot this desk.");
  } finally {
    state.computerImagesBusy = false;
    if (state.modal === "computers") paintModal();
  }
}

async function restoreDeskImage(computerId: string | undefined, imageId: string | undefined): Promise<void> {
  if (!computerId || !imageId || state.computerImagesBusy) return;
  state.computerImagesBusy = true;
  if (state.modal === "computers") paintModal();
  try {
    await api(`/api/computers/${computerId}/images/${imageId}/restore`, { method: "POST", body: {} });
    await loadComputers();
    await loadComputerImages(computerId);
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not restore that snapshot.");
  } finally {
    state.computerImagesBusy = false;
    if (state.modal === "computers") paintModal();
  }
}

async function deleteDeskImage(computerId: string | undefined, imageId: string | undefined): Promise<void> {
  if (!computerId || !imageId || state.computerImagesBusy) return;
  state.computerImagesBusy = true;
  if (state.modal === "computers") paintModal();
  try {
    await api(`/api/computers/${computerId}/images/${imageId}`, { method: "DELETE" });
    await loadComputerImages(computerId);
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not delete that snapshot.");
  } finally {
    state.computerImagesBusy = false;
    if (state.modal === "computers") paintModal();
  }
}

async function persistCloudIdentity(
  bot: Bot,
  attach: { provider: string; model: string; identityId: string },
): Promise<void> {
  try {
    const snap = (await api(`/api/cloud/draft/bots/${bot.id}`, {
      method: "PATCH",
      body: {
        computerId: cloudDeskIdOf(bot),
        identityId: workerCloudIdentityId(attach.identityId),
        harness: { provider: attach.provider, model: attach.model },
      },
    })) as CloudDraftState & { bot?: Bot };
    if (snap?.bots) state.cloudDraft = snap;
    const next = snap?.bot || (snap?.bots || []).find((row) => row.id === bot.id);
    if (next?.identityId) bot.identityId = next.identityId;
    if (next?.harness) bot.harness = next.harness;
  } catch (err) {
    window.alert((err as CaughtError | undefined)?.message || "Could not attach that identity.");
  }
}

async function saveBot(): Promise<void> {
  const bot = currentBot();
  if (!bot) return;
  if (isLiveCloud()) {
    const attach = editorHarnessFromIdentity(bot);
    const snap = await api(`/api/cloud/draft/bots/${bot.id}`, {
      method: "PATCH",
      body: {
        computerId: cloudDeskIdOf(bot),
        name: $<ValueEl>("#bn")?.value ?? bot.name,
        job: $<ValueEl>("#bi")?.value || $<ValueEl>("#bd")?.value || bot.instructions || bot.description,
        description: $<ValueEl>("#bd")?.value ?? bot.description,
        instructions: $<ValueEl>("#bi")?.value ?? bot.instructions,
        identityId: workerCloudIdentityId(attach.identityId),
        harness: { provider: attach.provider, model: attach.model },
      },
    }) as CloudDraftState;
    state.cloudDraft = snap;
    state.botEdit = false;
    render();
    return;
  }
  if (isCloudPlace()) {
    const attach = editorHarnessFromIdentity(bot);
    const snap = await api(`/api/cloud/draft/bots/${bot.id}`, {
      method: "PATCH",
      body: {
        name: $<ValueEl>("#bn")?.value ?? bot.name,
        description: $<ValueEl>("#bd")?.value ?? bot.description,
        instructions: $<ValueEl>("#bi")?.value ?? bot.instructions,
        identityId: attach.identityId || bot.identityId || "",
        harness: { provider: attach.provider, model: attach.model },
        color: bot.color,
        avatar: defaultAvatar(bot.avatar),
      },
    }) as CloudDraftState;
    state.cloudDraft = snap;
    state.botEdit = false;
    render();
    return;
  }
  const next = await api(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: {
      name: $<ValueEl>("#bn")?.value ?? bot.name,
      title: $<ValueEl>("#bt")?.value ?? bot.title,
      description: $<ValueEl>("#bd")?.value ?? bot.description,
      instructions: $<ValueEl>("#bi")?.value ?? bot.instructions,
      identityId: $<ValueEl>("#bid")?.value || "",
      harness: {
        provider: $<ValueEl>("#bh")?.value || bot.harness?.provider || "default",
        model: ($<ValueEl>("#bm")?.value ?? bot.harness?.model ?? "").trim(),
      },
      notificationsEnabled: bot.notificationsEnabled,
      color: bot.color,
      avatar: defaultAvatar(bot.avatar),
    },
  }) as Bot;
  state.botEdit = false;
  // Keep the local transcript. refresh() + loadBotHistory(tail=120) jumps a long thread.
  const messages = bot.messages;
  const messagesTruncated = bot.messagesTruncated;
  const busy = bot.busy;
  Object.assign(bot, next, { messages, messagesTruncated, busy });
  render();
}

async function deleteMessages(ids: string[]): Promise<void> {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || !ids?.length) return;
  const drop = new Set(ids);
  for (const id of ids) forgottenMessages.add(`${bot.id}:${id}`);
  bot.messages = (bot.messages || []).filter((m) => !drop.has(m.id as string));
  paintChat(bot);
  try {
    const q = ids.length > 1 ? `?ids=${encodeURIComponent(ids.slice(1).join(","))}` : "";
    // deleteMessages() is only called with a non-empty id list.
    const next = await api(`/api/bots/${bot.id}/messages/${encodeURIComponent(ids[0]!)}${q}`, { method: "DELETE" }) as { messages?: Message[] } | null;
    if (Array.isArray(next?.messages)) bot.messages = next.messages.filter((m) => !drop.has(m.id as string));
    paintChat(bot);
  } catch (err) {
    for (const id of ids) forgottenMessages.delete(`${bot.id}:${id}`);
    window.alert((err as CaughtError | undefined)?.message || "Could not delete the message.");
    await refresh();
  }
}

async function resetVm(): Promise<void> {
  if (!state.selected) return;
  await api(`/api/bots/${state.selected}/vm`, { method: "POST", body: { action: "reset" } });
  liveFrameKey = null;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) mountLiveFrame(bot);
}

function reconnectStream(): void {
  if (isCloudPlace()) {
    liveFrameKey = null;
    attachLiveFrame(currentBot());
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
  api(`/api/bots/${bot.id}/stream-health`)
    .then((h) => {
      if (state.selected !== bot.id) return;
      const applied = applyHealthPort(bot, h as StreamHealth);
      // applyHealthPort answers the same bot with only vm.novncPort swapped; the
      // narrower StreamBot it declares describes the same object.
      const live = applied.changed ? applied.bot as Bot : bot;
      if (applied.changed) {
        const i = state.bots.findIndex((b) => b.id === bot.id);
        if (i >= 0) state.bots[i] = { ...state.bots[i]!, vm: live.vm as BotVm | null };
      }
      liveFrameKey = null;
      attachLiveFrame(live);
    })
    .catch(() => {
      scheduleStreamRetry(bot, 0);
    });
}

async function rebootVm(): Promise<void> {
  if (isCloudPlace() || !state.selected) return;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  bot.vm = { ...(bot.vm || {}), status: "starting", hint: "Rebooting the computer…", error: null };
  paintLivePane(bot);
  attachLiveFrame(bot);
  try {
    const next = await api(`/api/bots/${bot.id}/vm`, { method: "POST", body: { action: "reboot" } }) as Bot;
    adoptBot(next);
    liveFrameKey = null;
    const live = state.bots.find((b) => b.id === bot.id) || next;
    attachLiveFrame(live);
    paintLivePane(live);
  } catch (err) {
    bot.vm = { ...(bot.vm || {}), status: "error", error: (err as CaughtError).message };
    paintLivePane(bot);
    window.alert((err as CaughtError).message || "Could not reboot the computer.");
  }
}

async function resumeVm(): Promise<void> {
  if (isCloudPlace() || !state.selected) return;
  if (dockerMissing()) {
    await recoverDocker();
    if (dockerMissing()) {
      paintDockerGate();
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        // dockerMissing() answered true, which required state.docker.
        bot.vm = { ...(bot.vm || {}), status: "error", error: state.docker!.hint };
        paintLivePane(bot);
      }
      return;
    }
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) {
    bot.vm = { ...(bot.vm || {}), status: "starting", error: null, hint: "Starting the computer…" };
    paintLivePane(bot);
  }
  try {
    await api(`/api/bots/${state.selected}/vm`, { method: "POST", body: { action: "start" } });
    await refresh();
    liveFrameKey = null;
    const live = state.bots.find((b) => b.id === state.selected);
    if (live) mountLiveFrame(live);
  } catch (err) {
    const live = state.bots.find((b) => b.id === state.selected);
    if (live) {
      live.vm = { ...(live.vm || {}), status: "error", error: (err as CaughtError).message };
      paintLivePane(live);
    } else {
      window.alert((err as CaughtError).message || "Could not start the computer.");
    }
  }
}

async function refresh(): Promise<void> {
  const incoming = await api("/api/bots") as Bot[];
  syncBots(incoming);
  try {
    state.teams = await api("/api/teams") as Team[];
  } catch {
    state.teams = state.teams || [];
  }
  await pullChannels();
  if (isCloudPlace()) {
    render();
    return;
  }
  const saved = state.selected || (typeof localStorage !== "undefined" ? localStorage.getItem("selectedBot") : null);
  if (saved && state.bots.some((b) => b.id === saved)) rememberSelected(saved);
  else if (state.bots[0]) rememberSelected(state.bots[0].id);
  render();
  if (state.selected) loadBotHistory(state.selected);
}

async function refreshSettings(): Promise<void> {
  const r = await api("/api/settings") as SettingsPayload;
  state.settings = r.settings;
  state.timezone = r.timezone;
  state.hasGrokAuth = Boolean(r.hasGrokAuth);
  if (r.account) state.account = r.account;
  if (r.account?.signedIn) await loadCloudDraft();
  if (r.docker) state.docker = r.docker;
  if (r.appVersion) state.appVersion = r.appVersion;
  applyTheme();
  paintDockerGate();
  await loadLocalHarness();
  loadHarnessStatus().catch(() => {});
  loadIdentities().catch(() => {});
}

async function loadLocalHarness(): Promise<void> {
  try {
    state.localHarness = await api("/api/harness/local") as LocalHarness;
  } catch {
    state.localHarness = {
      ollama: { ok: false, models: [] },
      lmstudio: { ok: false, models: [] },
      grok: { ok: true, models: grokModels() },
    };
  }
}

function wantsGrokBuild(): boolean {
  const p = state.settings?.harness?.provider;
  return p === "grok-build" || !p;
}

function resetChatChrome(): void {
  const chat = $("#chat");
  if (chat) {
    delete chat.dataset.ui;
    chat.replaceChildren();
  }
  state.chatFollowBot = null;
  state.chatExtra = 0;
}

async function applyAccount(next: AccountState | null): Promise<void> {
  const prevView = state.account?.view;
  state.account = next;
  state.accountBusy = false;
  if (next?.email) state.accountEmail = next.email;
  if (next?.signedIn) await loadCloudDraft();
  if (prevView && next?.view && prevView !== next.view) resetChatChrome();
  paintAccountGate();
  if (state.modal === "settings") paintModal();
  render();
}

async function loadCloudDraft(): Promise<void> {
  if (!state.account?.signedIn || cloudComingSoon()) {
    state.cloudDraft = { computers: [], bots: [] };
    return;
  }
  try {
    const snap = await api("/api/cloud/draft") as CloudDraftState;
    // mergeCloudDraft only touches id/messages, so it types its rows by those.
    state.cloudDraft = mergeCloudDraft(state.cloudDraft, snap) as CloudDraftState;
    const bots = state.cloudDraft?.bots || [];
    if (state.selectedCloud) state.selectedCloud = String(state.selectedCloud).replace(/^cloud:/, "cloud-");
    if (!state.selectedCloud || !bots.some((b) => b.id === state.selectedCloud)) {
      state.selectedCloud = bots[0]?.id || null;
    }
    const pending = (state.cloudDraft.computers || []).some((c) => c.status === "warming" || c.status === "attaching");
    if (pending && isCloudPlace()) {
      setTimeout(() => {
        loadCloudDraft().then(() => {
          if (isCloudPlace()) {
            attachLiveFrame(currentBot());
            scheduleCloudStreamWatch(400);
          }
        });
      }, 4000);
    } else if (isCloudPlace()) {
      scheduleCloudStreamWatch(400);
    }
  } catch {
    state.cloudDraft = { computers: [], bots: [] };
  }
}

async function switchPlace(id: string | undefined): Promise<void> {
  if (id === "local") {
    state.cloudSoonOpen = false;
    if (cloudComingSoon() || !isCloudPlace()) {
      paintPlaceSwitch();
      paintCloudSoon();
      return;
    }
  }
  if (id === "cloud" && cloudComingSoon()) {
    state.cloudSoonOpen = true;
    paintPlaceSwitch();
    paintCloudSoon();
    return;
  }
  if (id === "cloud" && !state.account?.signedIn) {
    state.cloudPromptLater = false;
    if (state.account) state.account.needsCloudPrompt = true;
    paintAccountGate();
    return;
  }
  try {
    const next = await api("/api/account/view", { method: "POST", body: { view: id } }) as AccountState;
    await applyAccount(next);
  } catch (err) {
    state.accountError = (err as CaughtError).message || "Could not switch place.";
    paintAccountGate();
  }
}

function paintCloudSoon(): void {
  let host = $("#cloud-soon-host");
  const main = $("#shell-root .main") || $(".main");
  if (!host) {
    host = document.createElement("div");
    host.id = "cloud-soon-host";
    if (main) main.appendChild(host);
    else document.body.appendChild(host);
  }
  if (!state.cloudSoonOpen) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = `<div class="cloud-soon">
    <p class="kicker">Cloud</p>
    <h2>Cloud is coming soon</h2>
    <p>Always-on desks that keep working when the lid is closed. Local stays on this computer. Sign in with X on <a href="https://sub8.bot" data-act="open-url" data-url="https://sub8.bot">sub8.bot</a> to get on the list.</p>
    <button type="button" class="pill" data-act="place" data-id="local">Back to Local</button>
  </div>`;
}

async function dismissCloudPrompt(): Promise<void> {
  try {
    const next = await api("/api/account/cloud-prompt", { method: "POST", body: { never: true } }) as AccountState;
    state.cloudPromptLater = true;
    await applyAccount(next);
  } catch (err) {
    state.accountError = (err as CaughtError).message || "Could not dismiss.";
    paintAccountGate();
  }
}

async function loadCloudBilling(): Promise<void> {
  if (!isLiveCloud()) return;
  try {
    state.cloudBilling = await api("/api/cloud/billing/summary") as CloudBilling;
    state.cloudBillingError = "";
  } catch (err) {
    state.cloudBillingError = (err as CaughtError | undefined)?.message || "Cloud billing failed";
    state.cloudBilling = state.cloudBilling || { skus: [] };
  }
  if (state.modal === "create" && state.createCloudKind === "bot") rebuildCreateModal();
}

function cloudPlanItems(sku: string, extra = 0): { sku: string; quantity: number }[] {
  const rows = state.cloudBilling?.skus || [];
  const items = [];
  for (const s of rows) {
    const paid = Number(s.paidQuantity || 0);
    const quantity = s.id === sku && extra ? paid + extra : paid;
    if (quantity > 0) items.push({ sku: s.id, quantity });
  }
  if (!items.some((i) => i.sku === sku)) items.push({ sku, quantity: Math.max(1, extra) });
  return items;
}

async function waitForCloudSkuSpare(sku: string, timeoutMs = 120000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await loadCloudBilling();
    if (cloudSkuUsage(sku).spare > 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return cloudSkuUsage(sku).spare > 0;
}

async function addCloudSkuToPlan(sku: string): Promise<void> {
  const out = await api("/api/cloud/billing/checkout", { method: "POST", body: { items: cloudPlanItems(sku, 1) } }) as { subscription?: unknown; url?: string };
  state.cloudBilling = { ...(state.cloudBilling || {}), ...(out.subscription ? { subscription: out.subscription } : {}) };
  if (out.url) {
    window.open(out.url, "_blank", "noopener");
    const ok = await waitForCloudSkuSpare(sku);
    if (!ok) throw new Error("Plan did not update yet. Finish checkout, then try Create again.");
    return;
  }
  await loadCloudBilling();
}

async function confirmCreateCloudDesk(): Promise<void> {
  const sku = state.createSku || "vm.4g";
  const u = cloudSkuUsage(sku);
  const btn = $<HTMLButtonElement>("#confirm-create");
  if (u.spare <= 0) {
    if (!state.createCloudPay) {
      state.createCloudPay = true;
      rebuildCreateModal();
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Updating plan…";
    }
    try {
      await addCloudSkuToPlan(sku);
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Confirm and create";
      }
      window.alert((err as CaughtError | undefined)?.message || "Could not update the plan.");
      return;
    }
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating…";
  }
  try {
    await createCloudComputer(sku);
    state.createCloudPay = false;
    state.modal = null;
    resetCreateForm();
    render();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = u.spare > 0 ? `Create ${u.name || "desk"}` : "Confirm and create";
    }
    if ((err as CaughtError | undefined)?.code === "NEED_BILLING") {
      state.createCloudPay = true;
      rebuildCreateModal();
      return;
    }
    window.alert((err as CaughtError | undefined)?.message || "Could not create the Cloud bot.");
  }
}

async function createCloudComputer(sku = "vm.4g"): Promise<CloudDraftState> {
  const snap = await api("/api/cloud/draft/computers", { method: "POST", body: { sku } }) as CloudDraftState;
  state.cloudDraft = snap;
  const created =
    snap.computer ||
    (snap.computers || []).find((c) => c.id === snap.computer?.id) ||
    (snap.bots || []).map((b) => b.desk || b.vm).find(Boolean);
  // `created` is either a desk row, which carries id, or a bot's vm, which
  // carries computerId; reading the other off it answered undefined before too.
  const deskId = (created as Computer | undefined)?.id || (created as BotVm | undefined)?.computerId;
  const bot = (snap.bots || []).find((b) => (b.computerId || b.vm?.computerId) === deskId);
  if (bot?.id) rememberSelected(bot.id);
  await loadCloudBilling();
  if (state.modal === "computers") paintModal();
  return snap;
}

async function destroyCloudComputer(id: string | undefined): Promise<void> {
  try {
    state.cloudDraft = await api(`/api/cloud/draft/computers/${id}`, { method: "DELETE" }) as CloudDraftState;
    if (state.modal === "computers") paintModal();
    else render();
  } catch (err) {
    window.alert((err as CaughtError).message || "Could not destroy the draft desk.");
  }
}

let cloudGrokPoll: number | null = null;

async function startCloudGrokOAuth(): Promise<void> {
  const wait = $("#cloud-grok-wait");
  try {
    const started = await api("/api/cloud/brain/grok/start", { method: "POST", body: {} }) as CloudGrokStart;
    const href = started.verificationUriComplete || started.verificationUri;
    if (wait) {
      wait.hidden = false;
      wait.innerHTML = `Open <a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Grok sign-in</a> on this device. Code <strong>${escapeHtml(started.userCode || "")}</strong>.`;
    }
    if (href) window.open(href, "_blank", "noopener");
    if (cloudGrokPoll) clearInterval(cloudGrokPoll);
    cloudGrokPoll = setInterval(async () => {
      try {
        const waited = await api(`/api/cloud/brain/grok/wait?id=${encodeURIComponent(started.id as string)}`) as { signedIn?: boolean };
        if (waited.signedIn) {
          // The interval was assigned before this callback could run.
          clearInterval(cloudGrokPoll!);
          cloudGrokPoll = null;
          await loadCloudDraft();
          await loadIdentities();
          render();
        }
      } catch (err) {
        clearInterval(cloudGrokPoll!);
        cloudGrokPoll = null;
        if (wait) wait.textContent = (err as CaughtError).message || "Grok sign-in failed.";
      }
    }, 4000);
  } catch (err) {
    if (wait) {
      wait.hidden = false;
      wait.textContent = (err as CaughtError).message || "Could not start Grok.";
    } else window.alert((err as CaughtError).message || "Could not start Grok.");
  }
}

async function saveCloudBrainKey(): Promise<void> {
  const provider = $<HTMLSelectElement>("#cloud-brain-provider")?.value || "spacexai";
  const apiKey = $<HTMLInputElement>("#cloud-brain-key")?.value || "";
  try {
    await api("/api/cloud/brain/key", { method: "POST", body: { provider, apiKey } });
    await loadCloudDraft();
    await loadIdentities();
    render();
  } catch (err) {
    window.alert((err as CaughtError).message || "Could not save the key.");
  }
}

async function signCloudHarness(id: string | undefined, kind: string | undefined): Promise<void> {
  if (!id) return;
  const harness =
    kind === "key"
      ? { provider: "spacexai", apiKeySet: true, apiKey: "sk-ant-draft", apiKeyHint: "sk-ant…" }
      : { provider: "grok-build", signedIn: true };
  try {
    const snap = await api(`/api/cloud/draft/computers/${id}`, { method: "PATCH", body: { harness } }) as CloudDraftState;
    state.cloudDraft = snap;
    render();
  } catch (err) {
    window.alert((err as CaughtError).message || "Could not update harness.");
  }
}

async function chooseLocalAccount(): Promise<void> {
  state.accountBusy = true;
  state.accountError = "";
  paintAccountGate();
  try {
    const next = await api("/api/account/local", { method: "POST", body: {} }) as AccountState;
    await applyAccount(next);
  } catch (err) {
    state.accountBusy = false;
    state.accountError = (err as CaughtError).message || "Could not continue on this Mac.";
    paintAccountGate();
  }
}

let xWait: { id: number } | null = null;

async function signInWithX(): Promise<void> {
  state.accountBusy = true;
  state.accountError = "";
  paintAccountGate();
  if (state.modal === "settings") paintModal();
  const token = { id: Date.now() };
  xWait = token;
  try {
    const started = await api("/api/account/x/start", { method: "POST" }) as AccountState;
    if (started.signedIn) {
      await applyAccount(started);
      return;
    }
    if (!started.authorizeUrl || !started.state) throw new Error("X sign-in did not start.");
    openExternal(started.authorizeUrl);
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
      const waited = await api(`/api/account/x/wait?state=${encodeURIComponent(started.state!)}`) as AccountState;
      if (waited.signedIn) {
        await applyAccount(waited);
        return true;
      }
      return false;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && xWait === token) poll().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    try {
      while (Date.now() < deadline && xWait === token) {
        await new Promise((r) => setTimeout(r, 800));
        if (xWait !== token) return;
        if (await poll()) return;
      }
    } finally {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    }
    if (xWait === token) throw new Error("Sign-in timed out. Try again.");
  } catch (err) {
    if (xWait !== token) return;
    state.accountBusy = false;
    state.accountError = (err as CaughtError).message || "Sign-in failed.";
    paintAccountGate();
    if (state.modal === "settings") paintModal();
  }
}

async function signInAccount(): Promise<void> {
  state.accountBusy = true;
  state.accountError = "";
  paintAccountGate();
  if (state.modal === "settings") paintModal();
  try {
    const next = await api("/api/account/magic", { method: "POST", body: { email: state.accountEmail } }) as AccountState;
    await applyAccount(next);
    if (next?.sent && !next?.signedIn) state.accountError = `Link sent to ${next.email}. Open it on this Mac.`;
  } catch (err) {
    state.accountBusy = false;
    state.accountError = (err as CaughtError).message || "Sign-in failed.";
    paintAccountGate();
    if (state.modal === "settings") paintModal();
  }
}

async function logoutAccount(): Promise<void> {
  xWait = null;
  try {
    const next = await api("/api/account/logout", { method: "POST", body: {} }) as AccountState;
    state.accountEmail = "";
    await applyAccount(next);
  } catch (err) {
    state.accountError = (err as CaughtError).message || "Could not sign out.";
    if (state.modal === "settings") paintModal();
  }
}

function paintAccountGate(): void {
  let host = $("#account-gate-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "account-gate-host";
    document.body.appendChild(host);
  }
  if (!cloudOn()) {
    host.innerHTML = "";
    return;
  }
  const a = state.account;
  const email = escapeHtml(state.accountEmail || "");
  const signInCard = a?.xLogin
    ? `<div class="account-place signin">
            <strong>Sign in with X</strong>
            <span>${a?.comingSoon ? "Creates your Sub8 account. Cloud desks are coming soon." : "Unlocks Cloud."}</span>
            <button type="button" class="pill primary" data-act="account-x" ${state.accountBusy ? "disabled" : ""}>${
              state.accountBusy ? "Waiting for X…" : "Sign in with X"
            }</button>
          </div>`
    : `<div class="account-place signin">
            <strong>Sign in</strong>
            <span>${a?.mockAuth ? "Dummy login — no email is sent. Unlocks the Cloud draft." : "Email a link. Unlocks Cloud."}</span>
            <input class="field" type="email" autocomplete="email" data-account-email value="${email}" placeholder="you@example.com" />
            <button type="button" class="pill primary" data-act="account-magic" ${state.accountBusy ? "disabled" : ""}>${
              state.accountBusy ? "Signing in…" : a?.mockAuth ? "Sign in" : "Email a link"
            }</button>
          </div>`;
  if (a && !a.ready && a.needsChoice) {
    host.innerHTML = `<div class="overlay account-gate" data-account-gate="1">
    <div class="modal account-gate-modal">
      <div class="sbody" style="width:100%">
        <h2>Where should this Sub8 live?</h2>
        <p class="muted">This Mac keeps chats on the device. Cloud is a separate place that would stay on after you close the laptop.</p>
        <div class="account-gate-grid">
          ${
            a.hideLocal
              ? ""
              : `<button type="button" class="account-place" data-act="account-local" ${state.accountBusy ? "disabled" : ""}>
            <strong>This Mac</strong>
            <span>Docker on this machine. No account. Same as today.</span>
          </button>`
          }
          ${signInCard}
        </div>
        ${state.accountError ? `<p class="muted" style="color:var(--danger)">${escapeHtml(state.accountError)}</p>` : ""}
        <p class="muted">Grok / Claude / Codex stay in Settings → Harness.</p>
      </div>
    </div>
  </div>`;
    return;
  }
  if (a?.needsCloudPrompt && !state.cloudPromptLater && !a.signedIn) {
    host.innerHTML = `<div class="overlay account-gate account-promo" data-account-gate="1">
    <div class="modal account-gate-modal">
      <div class="sbody" style="width:100%">
        <h2>Try Cloud?</h2>
        <p class="muted">Your Bots stay on this Mac. Cloud is a draft of a desk that would keep working with the lid closed — Grok on that VM, or an Anthropic API key.</p>
        <div class="account-gate-grid">${signInCard}</div>
        ${state.accountError ? `<p class="muted" style="color:var(--danger)">${escapeHtml(state.accountError)}</p>` : ""}
        <div class="routine-editor-foot">
          <button type="button" class="pill" data-act="account-cloud-never">Don't show again</button>
          <button type="button" class="pill primary" data-act="account-cloud-later">Not now</button>
        </div>
      </div>
    </div>
  </div>`;
    return;
  }
  host.innerHTML = "";
}

function paintGrokAuth(): void {
  const host = $("#grok-auth-host");
  if (host) host.innerHTML = "";
}

let brainPoll: number | null = null;

function readBrainApiForm(): BrainApiDraft {
  const api = { ...(state.brainSetup?.api || {}) };
  const url = document.querySelector<ValueEl>("[data-brain-api=baseUrl]")?.value;
  const key = document.querySelector<ValueEl>("[data-brain-api=apiKey]")?.value;
  const model = document.querySelector<ValueEl>("[data-brain-api=model]")?.value;
  if (url != null) api.baseUrl = url;
  if (key != null) api.apiKey = key;
  if (model != null) api.model = model;
  if (state.brainSetup) state.brainSetup.api = api;
  return api;
}

function paintBrainSetup(): void {
  let host = $("#brain-setup-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "brain-setup-host";
    document.body.appendChild(host);
  }
  if (!state.brainSetup) {
    host.innerHTML = "";
    if (brainPoll) {
      clearInterval(brainPoll);
      brainPoll = null;
    }
    return;
  }
  const catalog = (state.harnessStatus?.catalog || []).filter((row) =>
    ["grok-build", "hermes", "claude", "codex", "cursor", "ollama", "lmstudio"].includes(row.id),
  );
  host.innerHTML = brainSetupHtml({
    tab: state.brainSetup.tab || "harness",
    harnesses: state.harnessStatus?.harnesses || {},
    catalog,
    api: state.brainSetup.api || { preset: "spacexai" },
    busy: Boolean(state.brainSetup.busy),
    error: state.brainSetup.error || "",
    polling: true,
  });
}

function startBrainPoll(): void {
  if (brainPoll) clearInterval(brainPoll);
  brainPoll = setInterval(async () => {
    if (!state.brainSetup) return;
    await loadHarnessStatus();
    paintBrainSetup();
  }, 3000);
}

function openBrainSetup(): void {
  const preset = apiPreset("spacexai");
  state.brainSetup = {
    tab: "harness",
    api: { preset: preset.id, baseUrl: preset.baseUrl, model: preset.model, apiKey: "" },
    busy: false,
    error: "",
  };
  paintBrainSetup();
  startBrainPoll();
}

function closeBrainSetup(): void {
  state.brainSetup = null;
  paintBrainSetup();
}

async function patchHarness(partial: HarnessSettingsState): Promise<void> {
  const harness = { ...(state.settings?.harness || {}), ...partial };
  state.settings = { ...(state.settings || {}), harness };
  await api("/api/settings", { method: "PUT", body: { harness } });
  await refreshSettings();
  await loadHarnessStatus();
}

async function useHarnessFromSetup(id: string | undefined): Promise<void> {
  if (!id) return;
  state.brainSetup = { ...(state.brainSetup || {}), busy: true, error: "" };
  paintBrainSetup();
  try {
    const preset = apiPreset(id);
    const harness: HarnessSettingsState = { provider: id, setupComplete: true, setupSkipped: false };
    if (id === "ollama") {
      harness.baseUrl = "http://127.0.0.1:11434/v1";
      harness.model = pickModelForProvider("ollama", "");
    } else if (id === "lmstudio") {
      harness.baseUrl = "http://127.0.0.1:1234/v1";
      harness.model = pickModelForProvider("lmstudio", "");
    } else if (id === "cursor") {
      harness.model = pickModelForProvider("cursor", "cursor-grok-4.6-low");
    } else if (isCliHost(id)) {
      harness.model = "";
    } else if (id === "grok-build") {
      harness.model = pickModelForProvider("grok-build", "grok-4.6");
      harness.baseUrl = "https://api.x.ai/v1";
    } else {
      harness.baseUrl = preset.baseUrl;
      harness.model = preset.model;
    }
    await patchHarness(harness);
    closeBrainSetup();
    render();
  } catch (err) {
    state.brainSetup = { ...(state.brainSetup || {}), busy: false, error: (err as CaughtError).message || "Could not save." };
    paintBrainSetup();
  }
}

async function saveApiFromSetup(): Promise<void> {
  const api = readBrainApiForm();
  const preset = apiPreset(api.preset || "spacexai");
  const baseUrl = String(api.baseUrl || preset.baseUrl || "").trim();
  const apiKey = String(api.apiKey || "").trim();
  const model = String(api.model || preset.model || "").trim();
  if (!apiKey) {
    state.brainSetup = { ...(state.brainSetup || {}), error: "Paste an API key." };
    paintBrainSetup();
    return;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    state.brainSetup = { ...(state.brainSetup || {}), error: "Base URL must start with http:// or https://." };
    paintBrainSetup();
    return;
  }
  state.brainSetup = { ...(state.brainSetup || {}), busy: true, error: "", api };
  paintBrainSetup();
  try {
    await patchHarness({
      provider: preset.id,
      baseUrl,
      apiKey,
      model,
      apiKeyEnv: preset.id === "spacexai" ? "XAI_API_KEY" : "",
      setupComplete: true,
      setupSkipped: false,
    });
    closeBrainSetup();
    render();
  } catch (err) {
    state.brainSetup = { ...(state.brainSetup || {}), busy: false, error: (err as CaughtError).message || "Could not save." };
    paintBrainSetup();
  }
}

async function skipBrainSetup(): Promise<void> {
  try {
    await patchHarness({ setupSkipped: true });
  } catch {
    /* still close */
  }
  closeBrainSetup();
}

function applyTheme(): void {
  const t = state.settings?.themePreference || "system";
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t === "system" ? "light dark" : t;
}

async function setHumanControl(on: boolean): Promise<void> {
  state.humanControl = on;
  paintControlChrome();
  if (isCloudPlace()) {
    const bot = currentBot();
    const deskId = bot?.computerId || bot?.desk?.id || bot?.vm?.computerId;
    try {
      if (deskId) {
        await api("/api/cloud/brain/control", {
          method: "POST",
          body: { computerId: deskId, on, botId: bot?.id, display: bot?.vm?.display },
        });
      }
    } catch {
      /* keep local toggle */
    }
    await loadCloudDraft();
    resetCloudMux($<HTMLElement>("#screen-wrap"));
    render();
    paintControlChrome();
    scheduleCloudStreamWatch(200);
    return;
  }
  const id = state.selected;
  if (!id) return;
  if (on) {
    await stopTurn();
    reconnectStream();
  }
  try {
    await api(`/api/bots/${id}/control`, { method: "POST", body: { on } });
  } catch {
    /* still local */
  }
  paintControlChrome();
}

function paintControlChrome(): void {
  const wrap = $("#screen-wrap");
  if (!wrap || wrap.dataset.empty) return;
  let bar = wrap.querySelector(".take-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "take-bar";
    wrap.appendChild(bar);
  }
  bar.innerHTML = state.humanControl
    ? `<button type="button" class="take-ctl on" data-act="release-control">You're driving · Release</button>`
    : `<button type="button" class="take-ctl" data-act="take-control">Take control</button>`;
  wrap.classList.toggle("human", Boolean(state.humanControl));
}

function listen(): void {
  let es: EventSource | null = null;
  let opened = false;
  let retry = 0;
  const attach = () => {
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
    es = new EventSource("/api/events");
    es.addEventListener("cloud-thread", (e: MessageEvent<string>) => {
      const d = JSON.parse(e.data);
      const bot = (state.cloudDraft?.bots || []).find((b) => b.id === d.botId);
      if (!bot) return;
      if (d.messagesFailed) return;
      bot.messages = mergeCloudMessages(bot.messages, d.messages);
      if (isCloudPlace()) render();
    });
    es.addEventListener("cloud", (e: MessageEvent<string>) => {
      const d = JSON.parse(e.data);
      if (!d || !Array.isArray(d.bots)) return;
      // mergeCloudDraft only touches id/messages, so it types its rows by those.
      state.cloudDraft = mergeCloudDraft(state.cloudDraft, d) as CloudDraftState;
      if (isCloudPlace()) render();
    });
    es.addEventListener("bots", (e: MessageEvent<string>) => {
      syncBots(JSON.parse(e.data));
      if (isCloudPlace()) return;
      if (state.bots.some((b) => b.teamId)) {
        pullTeams().finally(() => render());
      } else {
        render();
      }
    });
    es.addEventListener("teams", (e: MessageEvent<string>) => {
      try {
        const rows = JSON.parse(e.data);
        if (Array.isArray(rows)) state.teams = rows;
      } catch {
        /* keep */
      }
      if (isCloudPlace()) return;
      render();
    });
    es.addEventListener("channels", (e: MessageEvent<string>) => {
      try {
        const rows = JSON.parse(e.data);
        if (Array.isArray(rows)) state.channels = rows;
      } catch {
        /* keep */
      }
      paintChannelRail();
    });
    es.addEventListener("job", (e: MessageEvent<string>) => {
      try {
        const { teamId, job } = JSON.parse(e.data);
        if (!teamId) return;
        const rows = Array.isArray(state.teams) ? state.teams : [];
        const i = rows.findIndex((t) => t.id === teamId);
        // findIndex answered >= 0, so the row is in bounds.
        if (i >= 0) {
          const row = { ...rows[i]! };
          if (job) row.job = job;
          else delete row.job;
          rows[i] = row;
        } else if (job) rows.push({ id: teamId, job });
        state.teams = rows;
      } catch {
        /* keep */
      }
      if (isCloudPlace()) return;
      const selected = state.bots.find((b) => b.id === state.selected);
      if (selected) paintJobBar(selected);
    });
    es.addEventListener("computers", () => {
      loadComputers();
    });
    es.addEventListener("routine", (e: MessageEvent<string>) => {
      const { botId, routine } = JSON.parse(e.data);
      if (!routine?.id) return;
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      const rows = Array.isArray(bot.routines) ? bot.routines : [];
      const i = rows.findIndex((r) => r.id === routine.id);
      if (i >= 0) rows[i] = routine;
      else rows.push(routine);
      bot.routines = rows;
      if (!isCloudPlace() && botId === state.selected) paintRoutineList(bot);
    });
    es.addEventListener("bot", (e: MessageEvent<string>) => {
      const bot = adoptBot(JSON.parse(e.data));
      if (isCloudPlace()) return;
      const selected = state.bots.find((b) => b.id === state.selected);
      if (selected && $("#thread")) {
        paintChat(selected);
        paintRoutineList(selected);
        if (state.botEdit) {
          const host = $("#bot-editor");
          const active = document.activeElement;
          const typing = Boolean(
            // host.contains(null) is false, so activeElement is an element here.
            host && host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active!.tagName),
          );
          if (host && !typing) delete host.dataset.bot;
          paintBotEditor(selected);
        }
        syncEditorChips(selected);
        refreshAvatars();
        if (bot.id === selected.id && (state.showComputer || state.deskSize === "full")) attachLiveFrame(selected);
      } else render();
    });
    es.addEventListener("harness-status", (e: MessageEvent<string>) => {
      try {
        const status = JSON.parse(e.data);
        if (status?.harnesses) {
          state.harnessStatus = status;
          if (status.local) state.localHarness = { ...state.localHarness, ...status.local };
        }
      } catch {
        /* keep */
      }
      paintHarnessBanner();
      if (state.modal === "settings" && state.section === "harness") paintModal();
    });
    es.addEventListener("control", (e: MessageEvent<string>) => {
      const { botId, on } = JSON.parse(e.data);
      if (isCloudPlace() || botId !== state.selected) return;
      // "control" carries TWO different payloads: the Take control toggle sends
      // `on`, and request_box_help sends {requestBoxHelp, reason} with no `on`
      // at all. Destructuring gave undefined for the latter, so a bot asking
      // for help repainted the chrome as "Take control" and cleared
      // humanControl -- telling the user the opposite of what happened, and
      // wiping the flag if they were already driving.
      //
      // Ignoring the frame is only half a fix: nothing in web/ renders
      // requestBoxHelp or its `reason`, so a bot that asks for help still goes
      // silently idle. Surfacing it is a UI decision, not a bug fix.
      if (typeof on !== "boolean") return;
      state.humanControl = on;
      paintControlChrome();
    });
    // The server sends SSE frames named "error"; they arrive as MessageEvents on
    // the same name EventSource uses for a transport failure, whose .data is
    // undefined and whose JSON.parse throws into the catch below, as before.
    es.addEventListener("error", (e) => {
      try {
        const { botId } = JSON.parse((e as MessageEvent<string>).data);
        const bot = state.bots.find((b) => b.id === botId);
        if (bot) {
          bot.busy = false;
          if (!isCloudPlace() && botId === state.selected && $("#thread")) paintChat(bot);
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("tool", (e: MessageEvent<string>) => {
      const { botId, name } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot || name === "send_message") return;
      bot.busy = true;
      if (!isCloudPlace() && botId === state.selected && $("#thread")) paintChat(bot);
    });
    es.addEventListener("teammate", (e: MessageEvent<string>) => {
      const data = JSON.parse(e.data);
      if (data.gone) {
        state.bots = state.bots.filter((b) => b.id !== data.gone);
        if (state.selected === data.gone) rememberSelected(state.bots.find((b) => !b.hidden)?.id || null);
      }
      if (data.bot) adoptBot(data.bot);
      api("/api/teams")
        .then((rows) => {
          state.teams = rows as Team[];
          render();
        })
        .catch(() => {});
    });
    es.addEventListener("team-message", (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data);
      let team = (state.teams || []).find((t) => t.id === msg.teamId) || teamFromBots(msg.teamId);
      if (team) {
        // The if() proved it; the callback is what loses the narrowing.
        if (!(state.teams || []).some((t) => t.id === team!.id)) {
          state.teams = [...(state.teams || []), team];
        }
        team = (state.teams || []).find((t) => t.id === msg.teamId) || team;
        team.messages = team.messages || [];
        if (!team.messages.some((m) => m.id === msg.id)) team.messages.push(msg);
      }
      const selected = state.bots.find((b) => b.id === state.selected);
      // A team message always carries a teamId, so this only enters with a bot.
      if (selected?.teamId === msg.teamId) {
        selected!.messages = selected!.messages || [];
        if (msg.role === "user") {
          selected!.messages = selected!.messages.filter(
            (m: Message) => !(String(m.id).startsWith("pending-") && m.content === msg.content),
          );
        }
        if (msg.id && !selected!.messages.some((m: Message) => m.id === msg.id)) selected!.messages.push(msg);
        if ($("#thread")) {
          paintChat(selected!);
          paintTeamTabs(selected!);
        }
      }
    });
    es.addEventListener("message", (e) => {
      const { botId, ...msg } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      // adoptBot() seeds .messages on every bot in state.bots.
      if (!bot.messages!.some((m) => m.id === msg.id)) {
        if (msg.role === "user") {
          bot.messages = bot.messages!.filter(
            (m) => !(String(m.id).startsWith("pending-") && m.content === msg.content),
          );
        }
        bot.messages!.push(msg);
        trimBotMessages(bot);
        if (botId !== state.selected && (msg.role === "assistant" || msg.kind === "tool")) {
          bot.unread = true;
          api(`/api/bots/${botId}`, { method: "PATCH", body: { unread: true } });
        }
      }
      if (isCloudPlace()) return;
      if (botId === state.selected && $("#thread")) {
        paintChat(bot);
      } else render();
    });
    es.addEventListener("log", (e: MessageEvent<string>) => {
      const { botId, m } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      const setup = /Setting up the computer \((\d+)\/(\d+)\):\s*(.+)/.exec(m);
      if (setup) {
        bot.vm = {
          ...(bot.vm || {}),
          hint: m,
          status: "starting",
          // Three capture groups, so a match carries all three.
          setup: { step: Number(setup[1]), total: Number(setup[2]), label: setup[3]!.trim(), ready: false },
        };
      } else if (/Computer is ready/i.test(m)) {
        bot.vm = {
          ...(bot.vm || {}),
          hint: "",
          status: "running",
          setup: { step: 4, total: 4, label: "Ready", ready: true },
        };
      } else {
        const keep = bot.vm?.setup?.ready === false ? false : bot.vm?.status === "running" || bot.vm?.status === "paused";
        // keep is only true when bot.vm.status said so, so the desk is on hand.
        bot.vm = { ...(bot.vm || {}), hint: m, status: keep ? bot.vm!.status || "running" : "starting" };
      }
      if (!isCloudPlace() && botId === state.selected) {
        paintScreenStatus(bot);
        const label = $("#screen-label");
        if (label && bot.vm.status === "starting" && !bot.vm.novncPort) label.textContent = m;
      }
    });
    es.addEventListener("vm-status", (e: MessageEvent<string>) => {
      const { botId, status, hint } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      bot.vm = { ...(bot.vm || {}), status: status || bot.vm?.status, hint: hint || bot.vm?.hint };
      if (!isCloudPlace() && botId === state.selected) paintScreenStatus(bot);
    });
    es.addEventListener("screen", (e: MessageEvent<string>) => {
      const { botId, url } = JSON.parse(e.data);
      if (isCloudPlace() || botId !== state.selected) return;
      const still = $<HTMLImageElement>(".screen-still");
      if (!still) return;
      if (url) refreshStill(still, botId);
    });
    es.onerror = () => {
      const label = $("#screen-label");
      /* keep the label as just the bot's screen name */
      if (es && es.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(attach, 1500);
      }
    };
    es.onopen = () => {
      if (!opened) {
        opened = true;
        return;
      }
      refresh().catch(() => {});
    };
  };
  attach();
}

let startingVm = false;
function watchStream(): void {
  if (isCloudPlace()) {
    watchCloudStream().catch(() => {});
    return;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot?.id || state.botEdit) return;
  if (!state.showComputer && state.deskSize !== "full") return;
  if (dockerMissing()) {
    attachLiveFrame(bot);
    return;
  }
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
  const vm = bot.vm || {};
  if (needsDesk(bot)) {
    attachLiveFrame(bot);
    return;
  }
  const needsStart = !["running", "starting", "paused", "exited", "stopped"].includes(vm.status || "");
  if (needsStart && !startingVm) {
    startingVm = true;
    resumeVm()
      .catch(() => {})
      .finally(() => {
        startingVm = false;
      });
    return;
  }
  api(`/api/bots/${bot.id}/stream-health`)
    .then((h) => {
      if (state.selected !== bot.id) return;
      const applied = applyHealthPort(bot, h as StreamHealth);
      if (applied.changed) {
        // changed means applyHealthPort built a new bot with a vm on it.
        bot.vm = applied.bot!.vm as BotVm | null;
        liveFrameKey = null;
        attachLiveFrame(bot);
      }
      if ((h as StreamHealth).docker) {
        const was = dockerMissing();
        // The if() above proved it; the cast is what loses the narrowing.
        state.docker = (h as StreamHealth).docker!;
        if (was !== dockerMissing()) attachLiveFrame(bot);
      }
      const wrap = $("#screen-wrap");
      const iframe = wrap?.querySelector("iframe");
      // healthIframeIsCurrent() only answers true for an iframe it found in wrap.
      if (healthIframeIsCurrent(iframe, bot)) {
        if ((h as StreamHealth).ok) {
          wrap!.dataset.iframeLoaded = "1";
          settleStreamWait(wrap);
        } else if (wrap!.dataset.streamReady !== "1") {
          beginStreamWait(wrap, bot.id);
        } else if (!wrap!.dataset.awaiting) {
          wrap!.dataset.awaiting = String(Date.now());
          clearTimeout(connectingTimer);
          connectingTimer = setTimeout(() => settleStreamWait(wrap), CONNECTING_AFTER_MS);
        }
        return;
      }
      if (needsDesk(bot)) {
        attachLiveFrame(bot);
        return;
      }
      if (!(h as StreamHealth).running && !startingVm && !["paused", "exited", "stopped"].includes(vm.status || "")) {
        startingVm = true;
        resumeVm()
          .catch(() => {})
          .finally(() => {
            startingVm = false;
          });
        return;
      }
      if (bot.vm?.novncPort) attachLiveFrame(bot);
    })
    .catch(() => {
      if (needsDesk(bot)) {
        attachLiveFrame(bot);
        return;
      }
      if (!startingVm) {
        startingVm = true;
        resumeVm()
          .catch(() => {})
          .finally(() => {
            startingVm = false;
          });
      }
    });
}

(async function init() {
  try {
  await refreshSettings();
  const ev = await runningAppVersion();
  if (ev) state.appVersion = ev;
  await refresh();
  listen();
  render();
  loadComputers().catch(() => {});
  setInterval(() => {
    if (state.modal === "computers") loadComputerStats();
  }, 4000);
  if (window.sub8Desktop?.onPausing) {
    window.sub8Desktop.onPausing(() => {
      let host = $("#quit-pause");
      if (!host) {
        host = document.createElement("div");
        host.id = "quit-pause";
        document.body.appendChild(host);
      }
      host.innerHTML = `<div class="overlay"><div class="modal" style="height:auto;width:min(400px,90%)"><div class="sbody" style="width:100%"><h2>Pausing computers…</h2><p class="muted">They'll wake when you open Sub8 again.</p></div></div></div>`;
    });
  }
  document.documentElement.dataset.appReady = "1";
  checkForUpdate({ silent: true }).catch(() => {});
  await loadHarnessStatus();
  if (setupQuery().get("setup") === "1" || needsBrainSetup(state.settings, state.harnessStatus)) {
    openBrainSetup();
  } else if (wantsGrokBuild() && state.hasGrokAuth === false) {
    state.grokAuthAsk = false;
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!isCloudPlace() && bot && bot.vm?.container && bot.vm.status !== "running") {
    resumeVm().catch(() => {});
  }
  setInterval(watchStream, 8_000);
  setInterval(() => {
    api("/api/health")
      .then((h) => {
        if (!(h as { docker?: DockerState } | null)?.docker) return;
        const was = dockerMissing();
        // The early return above proved it; the cast is what loses the narrowing.
        state.docker = (h as { docker?: DockerState }).docker!;
        const now = dockerMissing();
        if (was && now) {
          paintDockerGate();
          return;
        }
        if (was === now) return;
        paintDockerGate();
        if (!now) {
          const bot = state.bots.find((b) => b.id === state.selected);
          if (bot) resumeVm().catch(() => {});
        }
      })
      .catch(() => {});
  }, 3_000);
  window.addEventListener("focus", () => {
    const bot = state.bots.find((b) => b.id === state.selected);
    const still = $<HTMLImageElement>(".screen-still");
    if (bot?.id && still) refreshStill(still, bot.id);
    if (state.accountBusy || (state.account && !state.account.signedIn)) {
      refreshSettings().catch(() => {});
    }
  });
  } catch (err) {
    console.error("Sub8 init failed", err);
    try {
      listen();
    } catch {
      /* ignore */
    }
    try {
      render();
      document.documentElement.dataset.appReady = "1";
    } catch (err2) {
      const app = document.getElementById("app");
      if (app && !app.querySelector("#shell-root")) {
        const msg = escapeHtml((err as CaughtError | undefined)?.message || String(err));
        app.innerHTML = `<div id="boot-error" class="boot-error" style="padding:28px;font:14px/1.45 system-ui,sans-serif"><h2 style="margin:0 0 8px">Sub8 failed to load</h2><p style="margin:0">${msg}</p><p style="margin:12px 0 0;opacity:.7">Reload the window. If it stays blank, open Developer Tools from the View menu.</p></div>`;
      }
    }
  }
})();
