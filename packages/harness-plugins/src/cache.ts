import type { HarnessExec, HarnessPlugin } from "./types.js";
import { pluginsForHarness } from "./registry.js";

export interface PluginsCacheEntry {
  plugins: HarnessPlugin[];
  checkedAt: number;
  /** Set when the last refresh failed; `plugins` then holds the previous good list. */
  error?: string | undefined;
}

/**
 * A per-harness cache over `listPlugins`, because listing probes every
 * server's health (10–20s for Claude) and a turn must never wait on it:
 * `peek` answers from cache and refreshes in the background when stale,
 * `get` waits (Settings → Refresh). Concurrent refreshes share one fetch.
 */
export interface PluginsCache {
  peek(harness: string, exec: HarnessExec): HarnessPlugin[] | null;
  get(harness: string, exec: HarnessExec, opts?: { force?: boolean | undefined }): Promise<PluginsCacheEntry>;
  invalidate(harness?: string): void;
}

export function createPluginsCache({ ttlMs = 10 * 60_000, now = () => Date.now() }: { ttlMs?: number; now?: () => number } = {}): PluginsCache {
  const entries = new Map<string, PluginsCacheEntry>();
  const inflight = new Map<string, Promise<PluginsCacheEntry>>();
  const stale = (e: PluginsCacheEntry | undefined) => !e || now() - e.checkedAt > ttlMs;

  function refresh(harness: string, exec: HarnessExec): Promise<PluginsCacheEntry> {
    const running = inflight.get(harness);
    if (running) return running;
    const src = pluginsForHarness(harness);
    const job = (async (): Promise<PluginsCacheEntry> => {
      try {
        if (!src) {
          const e = { plugins: [], checkedAt: now() };
          entries.set(harness, e);
          return e;
        }
        const plugins = await src.listPlugins(exec);
        const e = { plugins, checkedAt: now() };
        entries.set(harness, e);
        return e;
      } catch (err) {
        const prev = entries.get(harness);
        const e = { plugins: prev?.plugins || [], checkedAt: now(), error: String((err as Error)?.message || err) };
        entries.set(harness, e);
        return e;
      } finally {
        inflight.delete(harness);
      }
    })();
    inflight.set(harness, job);
    return job;
  }

  return {
    peek(harness, exec) {
      const e = entries.get(harness);
      if (stale(e)) void refresh(harness, exec);
      return e ? e.plugins : null;
    },
    async get(harness, exec, { force = false } = {}) {
      const e = entries.get(harness);
      if (!force && e && !stale(e)) return e;
      return refresh(harness, exec);
    },
    invalidate(harness) {
      if (harness) entries.delete(harness);
      else entries.clear();
    },
  };
}
