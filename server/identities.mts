import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir } from "./paths.mjs";
import * as store from "@sub8/store";
import {
  catalog,
  kindForProvider,
  migrateProviderToIdentity,
  normalizeIdentity,
  providerLabel,
  resolveAttach,
  type Identity,
  type IdentityPlace,
  type IdentityProvider,
} from "@sub8/identities";
import { statusForIdentity, type HarnessRow, type IdentityProbeStatus } from "@sub8/harness-auth";

export interface IdentityProbe {
  harnesses?: Record<string, HarnessRow> | undefined;
}

/** Sub8's old automatic Claude default on the Worker (never a user's pick). */
const LEGACY_AUTO_CLAUDE_MODELS = ["claude-sonnet-4-5"];

/**
 * The model a Cloud Claude identity shows and runs: the login's pick, or
 * "default" (no --model: the desk CLI's own latest model) when there is none.
 */
export function cloudClaudeModel(brain: { claudeModel?: string | undefined; model?: string | undefined } | null | undefined): string {
  const picked = String(brain?.claudeModel || "").trim();
  if (picked) return picked;
  const m = String(brain?.model || "").trim();
  if (/^claude/i.test(m) && !LEGACY_AUTO_CLAUDE_MODELS.includes(m)) return m;
  return "default";
}

export function identityRuntimeDir(identity: Pick<Identity, "id" | "runtimeRef" | "provider">): string {
  if (identity.runtimeRef === "host" || !identity.runtimeRef) {
    return "";
  }
  // runtimeRef arrives verbatim from POST /api/identities. It names one
  // directory; a "../.." there sent the host CLI's isolated HOME (and the
  // credentials written into it) anywhere on disk.
  const ref = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(identity.runtimeRef) ? identity.runtimeRef : identity.id;
  return path.join(dataDir, "identities", ref, identity.provider);
}

/**
 * Engines whose CLI keeps its whole login under one directory we can point it
 * at, so two identities of the same engine can hold two different accounts:
 *
 * - claude: CLAUDE_CONFIG_DIR. On macOS the OAuth token lives in the Keychain,
 *   but under a service named "Claude Code-credentials-<sha256(dir)[0:8]>", so a
 *   different config dir is a different Keychain item (the default ~/.claude
 *   login is the unsuffixed "Claude Code-credentials").
 * - codex: CODEX_HOME (auth.json inside it).
 * - grok-build: GROK_HOME (auth.json inside it).
 *
 * Cursor, Hermes and the local engines keep one login per Mac.
 */
export const SEPARATE_LOGIN_ENV: Readonly<Record<string, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  "grok-build": "GROK_HOME",
};

export function supportsSeparateLogin(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(SEPARATE_LOGIN_ENV, provider);
}

/** A local identity with its own login directory (not this Mac's default login). */
export function isIsolatedIdentity(identity: Pick<Identity, "place" | "runtimeRef" | "provider"> | null | undefined): boolean {
  if (!identity || identity.place === "cloud") return false;
  const ref = String(identity.runtimeRef || "");
  if (!ref || ref === "host" || ref === "brain" || ref === "account") return false;
  return supportsSeparateLogin(identity.provider);
}

/**
 * The env a CLI child needs to run as this identity: its login directory, and
 * nothing that would shadow that login. Empty for the shared (host) identity,
 * which keeps running exactly as before.
 */
export function identityCliEnv(identity: Pick<Identity, "id" | "place" | "runtimeRef" | "provider">): Record<string, string> {
  if (!isIsolatedIdentity(identity)) return {};
  const key = SEPARATE_LOGIN_ENV[identity.provider];
  const dir = identityRuntimeDir(identity);
  return key && dir ? { [key]: dir } : {};
}

/** Apply identityCliEnv to a spawn env, dropping inherited credentials that would win over it. */
export function applyIdentityEnv(env: NodeJS.ProcessEnv, identity: Pick<Identity, "id" | "place" | "runtimeRef" | "provider"> | null | undefined): NodeJS.ProcessEnv {
  if (!identity) return env;
  const extra = identityCliEnv(identity);
  if (!Object.keys(extra).length) return env;
  const next: NodeJS.ProcessEnv = { ...env, ...extra };
  if (identity.provider === "claude") {
    // Any of these beats the config dir's own login, and they belong to the
    // shell that launched Sub8, not to this identity.
    delete next.ANTHROPIC_API_KEY;
    delete next.ANTHROPIC_AUTH_TOKEN;
    delete next.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (identity.provider === "codex") delete next.OPENAI_API_KEY;
  return next;
}

/** What the cleanup rule needs to know about one identity's own login. */
export interface CleanupFacts {
  /** null = could not tell (probe failed); never cleaned up then. */
  ownCredentials: boolean | null;
  loginActive?: boolean;
}

/**
 * Identities that were added but never signed in: isolated, no credentials of
 * their own, no bot attached, no sign-in under way, and not brand new (the
 * user may be about to sign in). Anything else is kept.
 */
export function cleanupCandidates(
  rows: readonly Identity[],
  facts: Readonly<Record<string, CleanupFacts | undefined>>,
  bots: ReadonlyArray<{ identityId?: unknown }>,
  { now = Date.now(), graceMs = 2 * 60_000 }: { now?: number; graceMs?: number } = {},
): Identity[] {
  const used = new Set(bots.map((b) => String(b?.identityId || "")).filter(Boolean));
  return rows.filter((row) => {
    if (!isIsolatedIdentity(row)) return false;
    if (used.has(row.id)) return false;
    const f = facts[row.id];
    if (!f || f.ownCredentials !== false || f.loginActive) return false;
    return now - (Number(row.createdAt) || 0) >= graceMs;
  });
}

export async function loadNormalizedIdentities(): Promise<Identity[]> {
  const raw = await store.loadIdentities();
  return raw.map((row) => normalizeIdentity(row)).filter((row): row is Identity => Boolean(row));
}

export async function persistIdentities(rows: readonly Identity[]): Promise<Identity[]> {
  const saved = await store.saveIdentities(rows.map((row) => ({ ...row })));
  return saved.map((row) => normalizeIdentity(row)).filter((row): row is Identity => Boolean(row));
}

/** First load: one identity per engine that already has a host login. */
export async function ensureHostIdentities(probe: IdentityProbe = {}): Promise<Identity[]> {
  const existing = await loadNormalizedIdentities();
  const have = new Set(existing.filter((row) => row.place === "local" && row.runtimeRef === "host").map((row) => row.provider));
  const extra: Identity[] = [];
  for (const entry of catalog()) {
    if (have.has(entry.id)) continue;
    const row = probe.harnesses?.[entry.id];
    if (!row || !(row.installed || row.signedIn || row.ready)) continue;
    extra.push(
      migrateProviderToIdentity(entry.id, {
        subject: String(row.extra?.email || ""),
        model: String(row.model || ""),
      }),
    );
  }
  if (!extra.length) return existing;
  return persistIdentities([...existing, ...extra]);
}

export interface CloudIdentityInput {
  brain?: {
    grokSignedIn?: unknown;
    grokName?: unknown;
    apiKeySet?: unknown;
    apiKeyHint?: unknown;
    provider?: unknown;
    model?: unknown;
    /** Worker-validated: tokens present and not expired. */
    claudeCredentials?: unknown;
  } | null;
  computerId?: string;
  claude?: { loggedIn?: unknown; email?: unknown } | null;
}

function upsertIdentityList(all: Identity[], row: Identity): Identity[] {
  const idx = all.findIndex((r) => r.id === row.id);
  if (idx >= 0) {
    const next = [...all];
    next[idx] = { ...next[idx], ...row, updatedAt: Date.now() };
    return next;
  }
  return [...all, row];
}

function brainProviderToIdentity(provider: string): IdentityProvider {
  const p = provider.trim().toLowerCase();
  if (p === "grok-oauth" || p === "grok-build") return "grok-build";
  if (p === "claude") return "claude";
  if (p === "openrouter") return "openrouter";
  if (p === "openai") return "openai";
  if (p === "custom") return "custom";
  return "spacexai";
}

/** Mirror account brain + desk Claude into `data/identities.json` so Settings → Identities can show Cloud rows. */
export async function ensureCloudIdentities(input: CloudIdentityInput = {}): Promise<Identity[]> {
  const existing = await loadNormalizedIdentities();
  let all = [...existing];
  let changed = false;
  const brain = input.brain;
  const now = Date.now();

  if (brain && (brain.grokSignedIn || String(brain.provider || "") === "grok-oauth")) {
    const name = String(brain.grokName || "").trim();
    const row = normalizeIdentity({
      id: "cloud-grok-brain",
      provider: "grok-build",
      place: "cloud",
      label: name ? `Grok Cloud · ${name}` : "Grok Cloud",
      subject: name,
      model: String((brain as { grokModel?: string }).grokModel || (/^grok/i.test(String(brain.model || "")) ? brain.model : "") || "grok-4.6"),
      runtimeRef: "brain",
      kind: "cli-oauth",
      createdAt: now,
      updatedAt: now,
    });
    if (row) {
      all = upsertIdentityList(all, row);
      changed = true;
    }
  }

  if (brain && brain.apiKeySet) {
    const prov = brainProviderToIdentity(String(brain.provider || "spacexai"));
    const row = normalizeIdentity({
      id: `cloud-api-${prov}`,
      provider: prov,
      place: "cloud",
      label: `${providerLabel(prov)} (Cloud API)`,
      subject: String(brain.apiKeyHint || "API key"),
      model: String(brain.model || ""),
      runtimeRef: "brain",
      kind: "api-key",
      createdAt: now,
      updatedAt: now,
    });
    if (row) {
      all = upsertIdentityList(all, row);
      changed = true;
    }
  }

  // ONE Claude row for the account. The credential is account-wide (every desk
  // adopts it), so a row per desk was wrong twice over: dead desks lingered as
  // "Claude on Cloud desk · NOT SIGNED IN" forever, and the live one claimed
  // SIGNED IN off a hollow credential. Legacy per-desk rows are pruned.
  const legacy = all.filter((r) => r.place === "cloud" && r.provider === "claude" && r.id !== "cloud-claude");
  if (legacy.length) {
    all = all.filter((r) => !legacy.includes(r));
    changed = true;
  }
  if (brain) {
    const email = String(input.claude?.email || "").trim();
    const prev = all.find((r) => r.id === "cloud-claude");
    const subject = email || String(prev?.subject || "");
    const row = normalizeIdentity({
      id: "cloud-claude",
      provider: "claude",
      place: "cloud",
      label: subject ? `Claude · ${subject}` : "Claude (Cloud)",
      subject,
      // The login's chosen model (Worker brain.claudeModel), never a constant — the
      // card repaints from this row, so a constant here snapped the picker back.
      // No pick = "default": the CLI's own latest model (no --model).
      model: cloudClaudeModel(brain as { claudeModel?: string; model?: string }),
      runtimeRef: "account",
      kind: "cli-oauth",
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    });
    if (row) {
      all = upsertIdentityList(all, row);
      changed = true;
    }
  }

  if (!changed) return existing;
  return persistIdentities(all);
}

export function cloudIdentityStatus(identity: Identity, ctx: CloudIdentityInput = {}): IdentityProbeStatus {
  if (identity.provider === "grok-build" && identity.runtimeRef === "brain") {
    return ctx.brain?.grokSignedIn ? "signed_in" : "signed_out";
  }
  if (identity.kind === "api-key" && identity.runtimeRef === "brain") {
    return ctx.brain?.apiKeySet ? "signed_in" : "signed_out";
  }
  if (identity.provider === "claude" && identity.place === "cloud") {
    // Signed in = the account credential is valid (Worker-checked: tokens and
    // not expired) OR the selected desk's CLI reports a login of its own.
    return ctx.brain?.claudeCredentials || ctx.claude?.loggedIn ? "signed_in" : "signed_out";
  }
  return identity.subject ? "signed_in" : "signed_out";
}

export function decorateCloudIdentity(identity: Identity, ctx: CloudIdentityInput = {}): Identity & { status: IdentityProbeStatus } {
  return { ...identity, status: cloudIdentityStatus(identity, ctx) };
}

export async function addIdentity(input: {
  provider?: string;
  place?: IdentityPlace;
  label?: string;
  subject?: string;
  model?: string;
  isolated?: boolean;
  runtimeRef?: string;
}): Promise<Identity> {
  const provider = (input.provider || "claude") as IdentityProvider;
  const isolated = input.isolated !== false && input.place !== "cloud";
  if (isolated && !input.runtimeRef && !supportsSeparateLogin(provider)) {
    // A second "isolated" Cursor/Hermes/... row would only ever run on this
    // Mac's one login while claiming to be separate.
    throw new Error(`${providerLabel(provider)} keeps one login per Mac. Separate logins work for Claude, Codex and Grok Build.`);
  }
  const id = randomUUID();
  const row = normalizeIdentity({
    id,
    provider,
    place: input.place || "local",
    label: input.label,
    subject: input.subject || "",
    model: input.model || "",
    kind: kindForProvider(provider),
    runtimeRef: input.runtimeRef || (isolated ? id : input.place === "cloud" ? "" : "host"),
  });
  if (!row) {
    const err = new Error("Unknown provider.");
    throw err;
  }
  const all = await loadNormalizedIdentities();
  all.push(row);
  await persistIdentities(all);
  return row;
}

export async function patchIdentity(id: string, patch: Partial<Identity>): Promise<Identity | null> {
  const all = await loadNormalizedIdentities();
  const idx = all.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  const next = normalizeIdentity({ ...all[idx], ...patch, id, updatedAt: Date.now() });
  if (!next) return null;
  all[idx] = next;
  await persistIdentities(all);
  return next;
}

export async function removeIdentity(id: string): Promise<boolean> {
  const all = await loadNormalizedIdentities();
  const next = all.filter((row) => row.id !== id);
  if (next.length === all.length) return false;
  await persistIdentities(next);
  return true;
}

/** This identity's own login, as identity-auth probed it. */
export interface OwnAuth {
  status: IdentityProbeStatus;
  email: string;
  ownCredentials: boolean | null;
}

/**
 * Status for Settings. The shared (host) identity reports this Mac's default
 * login. An isolated one reports ONLY its own login: reading the Mac's default
 * there is what made every "+ Add login" row claim "Signed in" at once.
 */
export function decorateIdentity(
  identity: Identity,
  probe: IdentityProbe = {},
  own?: OwnAuth | null,
): Identity & { status: IdentityProbeStatus; email: string; separate: boolean; ownCredentials?: boolean | null } {
  if (isIsolatedIdentity(identity)) {
    const row = probe.harnesses?.[identity.provider];
    const status: IdentityProbeStatus = row && row.installed === false ? "not_installed" : own?.status || "signed_out";
    return { ...identity, status, email: own?.email || "", separate: true, ownCredentials: own ? own.ownCredentials : null };
  }
  const row = probe.harnesses?.[identity.provider];
  const email = identity.place === "local" ? String(row?.extra?.email || "") : "";
  return { ...identity, status: statusForIdentity(row), email: email || identity.subject || "", separate: false };
}

export async function attachForBot(
  bot: import("@sub8/identities").AttachBot | null | undefined,
  probe: IdentityProbe = {},
): Promise<ReturnType<typeof resolveAttach>> {
  const identities = await ensureHostIdentities(probe);
  const settings = await store.loadSettings();
  const defaultId = identities.find((row) => row.provider === (settings.harness?.provider || "grok-build") && row.runtimeRef === "host")?.id;
  return resolveAttach(bot, identities, defaultId);
}
