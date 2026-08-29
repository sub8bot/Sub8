import type {
  AttachBot,
  BotAttach,
  CatalogEntry,
  Identity,
  IdentityInput,
  IdentityKind,
  IdentityPlace,
  IdentityProvider,
  IdentityStatus,
} from "./types.js";
import { IDENTITY_PROVIDERS } from "./types.js";

const LABELS: Record<IdentityProvider, string> = {
  "grok-build": "Grok Build",
  hermes: "Hermes",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  spacexai: "SpaceXAI",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  custom: "Custom API",
  sub8: "Sub8",
};

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return IDENTITY_PROVIDERS.includes(value as IdentityProvider);
}

export function kindForProvider(provider: string): IdentityKind {
  if (provider === "ollama" || provider === "lmstudio") return "local-openai";
  if (provider === "spacexai" || provider === "openrouter" || provider === "openai" || provider === "custom") {
    return "api-key";
  }
  if (provider === "sub8") return "sub8-metered";
  return "cli-oauth";
}

export function catalog(): readonly CatalogEntry[] {
  return IDENTITY_PROVIDERS.filter((id) => id !== "sub8").map((id) => ({
    id,
    label: LABELS[id],
    kind: kindForProvider(id),
  }));
}

export function providerLabel(provider: string): string {
  return isIdentityProvider(provider) ? LABELS[provider] : "This harness";
}

function asPlace(value: unknown): IdentityPlace {
  return value === "cloud" ? "cloud" : "local";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTime(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function normalizeIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as IdentityInput;
  const provider = isIdentityProvider(row.provider) ? row.provider : null;
  if (!provider) return null;
  const now = Date.now();
  const id = asString(row.id);
  if (!id) return null;
  const kind = row.kind === "cli-oauth" || row.kind === "api-key" || row.kind === "local-openai" || row.kind === "sub8-metered"
    ? row.kind
    : kindForProvider(provider);
  const label = asString(row.label) || `${LABELS[provider]}${asString(row.subject) ? ` · ${asString(row.subject)}` : ""}`;
  return {
    id,
    label,
    place: asPlace(row.place),
    provider,
    kind,
    subject: asString(row.subject),
    runtimeRef: asString(row.runtimeRef) || (asPlace(row.place) === "cloud" ? "" : "host"),
    model: asString(row.model),
    createdAt: asTime(row.createdAt, now),
    updatedAt: asTime(row.updatedAt, now),
  };
}

export function migrateProviderToIdentity(
  provider: string,
  extras: { id?: string; subject?: string; place?: IdentityPlace; label?: string; runtimeRef?: string; model?: string } = {},
): Identity {
  const id = extras.id || `id-${provider.replace(/[^a-z0-9]+/gi, "-")}-host`;
  return normalizeIdentity({
    id,
    provider: isIdentityProvider(provider) ? provider : "grok-build",
    place: extras.place || "local",
    subject: extras.subject || "",
    label: extras.label,
    runtimeRef: extras.runtimeRef || (extras.place === "cloud" ? extras.runtimeRef || "" : "host"),
    model: extras.model || "",
  }) as Identity;
}

export function listByPlace(identities: readonly Identity[], place: IdentityPlace): Identity[] {
  return identities.filter((row) => row.place === place);
}

export function canAttach(identity: Identity, status?: IdentityStatus): boolean {
  if (identity.kind === "sub8-metered") return false;
  if (status === "signed_out" || status === "expired" || status === "not_installed") return false;
  if (identity.kind === "local-openai" && status === "not_running") return false;
  return true;
}

export function resolveAttach(
  bot: AttachBot | null | undefined,
  identities: readonly Identity[],
  defaultId?: string,
): BotAttach | null {
  const byId = new Map(identities.map((row) => [row.id, row]));
  const wanted = asString(bot?.identityId) || asString(defaultId);
  let row = wanted ? byId.get(wanted) : undefined;
  if (!row) {
    const provider = asString(bot?.harness?.provider);
    if (provider && provider !== "default") {
      row = identities.find((item) => item.provider === provider && item.place !== "cloud")
        || identities.find((item) => item.provider === provider);
    }
  }
  if (!row && defaultId) row = byId.get(defaultId);
  if (!row) row = identities.find((item) => item.place === "local") || identities[0];
  if (!row) return null;
  const model = asString(bot?.harness?.model) || row.model;
  return {
    identityId: row.id,
    provider: row.provider,
    model,
    place: row.place,
    runtimeRef: row.runtimeRef,
  };
}
