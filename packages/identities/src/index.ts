export type {
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
export { IDENTITY_PROVIDERS } from "./types.js";

export {
  canAttach,
  catalog,
  isIdentityProvider,
  kindForProvider,
  listByPlace,
  migrateProviderToIdentity,
  normalizeIdentity,
  providerLabel,
  resolveAttach,
} from "./identities.js";
