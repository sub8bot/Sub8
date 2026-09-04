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

export function identityRuntimeDir(identity: Pick<Identity, "id" | "runtimeRef" | "provider">): string {
  if (identity.runtimeRef === "host" || !identity.runtimeRef) {
    return "";
  }
  return path.join(dataDir, "identities", identity.runtimeRef || identity.id, identity.provider);
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
      model: String((brain as { claudeModel?: string }).claudeModel || (/^claude/i.test(String(brain.model || "")) ? brain.model : "") || "claude-sonnet-5"),
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

export function decorateIdentity(identity: Identity, probe: IdentityProbe = {}): Identity & { status: ReturnType<typeof statusForIdentity> } {
  return { ...identity, status: statusForIdentity(probe.harnesses?.[identity.provider]) };
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
