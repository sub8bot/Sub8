export const HERMES_FALLBACK_MODELS = ["qwen3.8-27b", "qwen3.6-27b-mlx"];
export const GROK_FALLBACK_MODELS = ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"];
/** Claude ids the CLI accepts. Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5; whether a login may use each is up to the account. */
export const CLAUDE_FALLBACK_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
export const CODEX_FALLBACK_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];
export const CURSOR_FALLBACK_MODELS = ["cursor-grok-4.6-low", "cursor-grok-4.6-low-fast", "auto", "composer-2.5"];

/**
 * What the server knows is installed. The named keys are the ones this file
 * reads; the index signature is the `catalogs[provider]` lookup at the bottom,
 * which serves any provider that just ships a list under its own name.
 */
export interface ModelCatalogs {
  grok?: string[];
  codex?: string[];
  cursor?: string[];
  ollama?: string[];
  lmstudio?: string[];
  hermesCurrent?: string;
  codexCurrent?: string;
  cursorCurrent?: string;
  [provider: string]: string[] | string | undefined;
}

/** `.filter(Boolean)` does not narrow; this does, and drops the same values. */
function present(value: string | undefined): value is string {
  return Boolean(value);
}

export function listModelsForProvider(provider: string, catalogs: ModelCatalogs = {}): string[] {
  if (provider === "grok-build" || provider === "spacexai") {
    const grok = Array.isArray(catalogs.grok) ? catalogs.grok : [];
    return grok.length ? grok : GROK_FALLBACK_MODELS.slice();
  }
  if (provider === "hermes") {
    return [
      ...new Set(
        [catalogs.hermesCurrent, ...(catalogs.lmstudio || []), ...HERMES_FALLBACK_MODELS].filter(present),
      ),
    ];
  }
  if (provider === "codex") {
    return [
      ...new Set(
        [catalogs.codexCurrent, ...(catalogs.codex || []), ...CODEX_FALLBACK_MODELS].filter(present),
      ),
    ];
  }
  if (provider === "cursor") {
    return [
      ...new Set(
        [catalogs.cursorCurrent, ...(catalogs.cursor || []), ...CURSOR_FALLBACK_MODELS].filter(present),
      ),
    ];
  }
  if (provider === "claude") {
    return [...new Set([...((catalogs.claude as string[] | undefined) || []), ...CLAUDE_FALLBACK_MODELS].filter(present))];
  }
  if (provider === "ollama") return Array.isArray(catalogs.ollama) ? catalogs.ollama : [];
  if (provider === "lmstudio") return Array.isArray(catalogs.lmstudio) ? catalogs.lmstudio : [];
  const extra = catalogs[provider];
  return Array.isArray(extra) ? extra : [];
}

export function modelFieldKind(provider: string, models: string[] | null | undefined): string {
  if (Array.isArray(models) && models.length) return "select";
  if (provider === "ollama" || provider === "lmstudio") return "detect";
  if (provider === "claude" || provider === "codex" || provider === "cursor") return "cli";
  if (provider === "default") return "app-default";
  return "text";
}

export function pickListedModel(provider: string, selected: string | undefined, models: string[] | null | undefined): string {
  const list = Array.isArray(models) ? models : [];
  if (list.length) {
    if (selected && list.includes(selected)) return selected;
    if (provider === "grok-build" || provider === "spacexai") {
      return list.includes("grok-4.6") ? "grok-4.6" : (list[0] ?? "");
    }
    if (provider === "cursor") {
      return list.includes("cursor-grok-4.6-low") ? "cursor-grok-4.6-low" : (list[0] ?? "");
    }
    return list[0] ?? "";
  }
  if (provider === "grok-build" || provider === "spacexai") return "grok-4.6";
  if (provider === "cursor") return "cursor-grok-4.6-low";
  return "";
}
