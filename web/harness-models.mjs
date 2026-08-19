export const HERMES_FALLBACK_MODELS = ["qwen3.8-27b", "qwen3.6-27b-mlx"];
export const GROK_FALLBACK_MODELS = ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"];
export const CODEX_FALLBACK_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];

export function listModelsForProvider(provider, catalogs = {}) {
  if (provider === "grok-build" || provider === "spacexai") {
    const grok = Array.isArray(catalogs.grok) ? catalogs.grok : [];
    return grok.length ? grok : GROK_FALLBACK_MODELS.slice();
  }
  if (provider === "hermes") {
    return [
      ...new Set(
        [catalogs.hermesCurrent, ...(catalogs.lmstudio || []), ...HERMES_FALLBACK_MODELS].filter(Boolean),
      ),
    ];
  }
  if (provider === "codex") {
    return [
      ...new Set(
        [catalogs.codexCurrent, ...(catalogs.codex || []), ...CODEX_FALLBACK_MODELS].filter(Boolean),
      ),
    ];
  }
  if (provider === "ollama") return Array.isArray(catalogs.ollama) ? catalogs.ollama : [];
  if (provider === "lmstudio") return Array.isArray(catalogs.lmstudio) ? catalogs.lmstudio : [];
  const extra = catalogs[provider];
  return Array.isArray(extra) ? extra : [];
}

export function modelFieldKind(provider, models) {
  if (Array.isArray(models) && models.length) return "select";
  if (provider === "ollama" || provider === "lmstudio") return "detect";
  if (provider === "claude" || provider === "codex") return "cli";
  if (provider === "default") return "app-default";
  return "text";
}

export function pickListedModel(provider, selected, models) {
  const list = Array.isArray(models) ? models : [];
  if (list.length) {
    if (selected && list.includes(selected)) return selected;
    if (provider === "grok-build" || provider === "spacexai") {
      return list.includes("grok-4.6") ? "grok-4.6" : list[0];
    }
    return list[0];
  }
  if (provider === "grok-build" || provider === "spacexai") return "grok-4.6";
  return "";
}
