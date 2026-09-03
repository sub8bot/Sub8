import type { HarnessPluginProvider } from "./types.js";
import { claudePlugins } from "./claude.js";

export type { PluginConnStatus, HarnessPlugin, ExecResult, HarnessExec, HarnessPluginProvider } from "./types.js";
export {
  CLAUDE_CONNECTORS_PAGE,
  pluginSlug,
  claudeStatus,
  claudeDisplayName,
  parseClaudeMcpList,
  claudePlugins,
} from "./claude.js";

/**
 * Every harness that exposes a plugin surface. Adding a harness is one entry
 * here plus its provider module; nothing else in the app has to change.
 */
export const PLUGIN_PROVIDERS: Record<string, HarnessPluginProvider> = {
  claude: claudePlugins,
};

/** The plugin provider for a harness id, or null when that harness has no plugin surface yet. */
export function pluginsForHarness(harness: string): HarnessPluginProvider | null {
  return PLUGIN_PROVIDERS[String(harness || "").trim()] || null;
}

/** Harness ids that currently expose a plugin surface. */
export function harnessesWithPlugins(): string[] {
  return Object.keys(PLUGIN_PROVIDERS);
}
