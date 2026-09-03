/**
 * The plugin surface of a harness, abstracted so the app can show every
 * harness's plugins and their connection status through one shape, however
 * each harness actually reports them.
 */

/** Normalized connection state of one plugin. */
export type PluginConnStatus = "connected" | "needs_auth" | "error" | "unknown";

/** One plugin/connector a harness exposes, with its live connection status. */
export interface HarnessPlugin {
  /** Stable, url-safe id within the harness (a slug of the full reported name). */
  id: string;
  /** Human label, e.g. "Gmail". */
  name: string;
  /** Harness this plugin belongs to, e.g. "claude". */
  harness: string;
  /** The server / endpoint URL, when the harness reports one. */
  url?: string | undefined;
  /** Transport marker the harness reported, e.g. "HTTP", "SSE". */
  transport?: string | undefined;
  /** Normalized connection status. */
  status: PluginConnStatus;
  /** The raw status text as the harness printed it, for display and debugging. */
  detail?: string | undefined;
  /** Where to send the user to connect this plugin, when it is not connected. */
  connectUrl?: string | undefined;
}

/** The result of running one command wherever a harness lives. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs a command on the machine a given harness actually lives on — the Mac
 * host for a local desk, the droplet for a cloud desk. It is injected rather
 * than imported so the provider stays pure and the same code serves every
 * place a harness can run.
 */
export interface HarnessExec {
  run(file: string, args: string[], opts?: { timeoutMs?: number | undefined }): Promise<ExecResult>;
}

/**
 * A harness's plugin capability. One implementation per harness; the registry
 * in index.ts maps a harness id to its provider.
 */
export interface HarnessPluginProvider {
  /** Harness id, e.g. "claude". Matches HARNESS_PROVIDERS ids. */
  readonly harness: string;
  /** Human label, e.g. "Claude". */
  readonly label: string;
  /** List the harness's plugins and their live connection status. */
  listPlugins(exec: HarnessExec): Promise<HarnessPlugin[]>;
  /** The page to open so the user can connect a plugin; null if unknown. */
  connectUrl(plugin: HarnessPlugin): string | null;
  /** Where the user adds or manages this harness's plugins (an "Add plugins" CTA); null if there is no such page. */
  readonly manageUrl: string | null;
}
