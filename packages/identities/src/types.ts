export const IDENTITY_PROVIDERS = [
  "grok-build",
  "hermes",
  "claude",
  "codex",
  "cursor",
  "ollama",
  "lmstudio",
  "spacexai",
  "openrouter",
  "openai",
  "custom",
  "sub8",
] as const;

export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export type IdentityPlace = "local" | "cloud";

export type IdentityKind = "cli-oauth" | "api-key" | "local-openai" | "sub8-metered";

/** Probed, never stored as the source of truth. */
export type IdentityStatus = "signed_in" | "signed_out" | "expired" | "not_running" | "not_installed";

export interface CatalogEntry {
  id: IdentityProvider;
  label: string;
  kind: IdentityKind;
}

export interface Identity {
  id: string;
  label: string;
  place: IdentityPlace;
  provider: IdentityProvider;
  kind: IdentityKind;
  /** Display email / handle when known. */
  subject: string;
  /**
   * How to spawn: `"host"` = this Mac's default CLI home;
   * a uuid = `data/identities/<id>/`;
   * a cloud computer id for a desk-scoped session.
   */
  runtimeRef: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityInput {
  id?: unknown;
  label?: unknown;
  place?: unknown;
  provider?: unknown;
  kind?: unknown;
  subject?: unknown;
  runtimeRef?: unknown;
  model?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BotAttach {
  identityId: string;
  provider: IdentityProvider;
  model: string;
  place: IdentityPlace;
  runtimeRef: string;
}

export interface AttachBot {
  identityId?: string | undefined;
  harness?: { provider?: string | undefined; model?: string | undefined } | undefined;
}
