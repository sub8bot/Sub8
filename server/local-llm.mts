/** One local OpenAI-compatible harness: where to talk to it and how to probe it. */
export interface LocalSpec {
  baseUrl: string;
  probe: string;
  key: string;
}

interface LocalDefaults {
  ollama: LocalSpec;
  lmstudio: LocalSpec;
  [provider: string]: LocalSpec | undefined;
}

/** `/api/tags`. Rows stay `any`: see the note on `idsFromOpenAI`. */
interface OllamaTags {
  models?: any[] | undefined;
}

/** `/v1/models`. `data` stays `unknown` until `Array.isArray` says otherwise. */
interface OpenAIModelList {
  data?: unknown;
}

/** What one probe reports back to the settings UI. */
export interface HarnessProbe {
  ok: boolean;
  installed: boolean;
  models: string[];
  baseUrl: string;
  error?: string;
}

export interface GrokProbe {
  ok: boolean;
  models: string[];
}

export interface LocalHarnesses {
  ollama: HarnessProbe;
  lmstudio: HarnessProbe;
  grok: GrokProbe;
}

const DEFAULTS: LocalDefaults = {
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", probe: "http://127.0.0.1:11434/api/tags", key: "ollama" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", probe: "http://127.0.0.1:1234/v1/models", key: "lm-studio" },
};

export const GROK_CHAT_MODELS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-build-0.1",
];

export function isGrokChatModel(id: unknown): boolean {
  const s = String(id || "").trim();
  if (!/^grok[-_]/i.test(s)) return false;
  if (/imagine|video|voice|image|tts|stt|whisper/i.test(s)) return false;
  return true;
}

function sortGrokModels(ids: string[]): string[] {
  return [...new Set(ids.filter(isGrokChatModel))].sort((a, b) => {
    if (a === "grok-4.6") return -1;
    if (b === "grok-4.6") return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

export async function listGrokChatModels(): Promise<GrokProbe> {
  const found = new Set(GROK_CHAT_MODELS);
  const key = process.env.XAI_API_KEY || "";
  if (key) {
    try {
      const data = await fetchJson<OpenAIModelList>("https://api.x.ai/v1/models", 2500, {
        Authorization: `Bearer ${key}`,
      });
      for (const id of idsFromOpenAI(data)) {
        if (isGrokChatModel(id)) found.add(id);
      }
    } catch {
      /* fallback catalog is enough */
    }
  }
  const models = sortGrokModels([...found]);
  return { ok: true, models };
}

/** Union rather than `value: LocalHarnesses | null` so assigning a filled
 * cache narrows it, and the `return cache.value` below needs no assertion. */
let cache: { at: number; value: LocalHarnesses } | { at: number; value: null } = { at: 0, value: null };

/**
 * Provider catalogs are unvalidated remote JSON, and `filter(Boolean)` is what
 * actually drops the rows with no id — something TypeScript cannot see through.
 * So the rows stay `any` rather than a declared shape that would have to lie.
 */
function idsFromOpenAI(data: OpenAIModelList | null | undefined): string[] {
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return rows
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .filter((id) => !/embed|embedding/i.test(id));
}

async function fetchJson<T = unknown>(url: string, ms = 1200, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as T;
}

export async function detectLocalHarnesses({ force = false }: { force?: boolean } = {}): Promise<LocalHarnesses> {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < 5000) return cache.value;
  const [ollama, lmstudio, grok] = await Promise.all([
    (async (): Promise<HarnessProbe> => {
      try {
        const data = await fetchJson<OllamaTags>(DEFAULTS.ollama.probe);
        const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
        return { ok: true, installed: true, models, baseUrl: DEFAULTS.ollama.baseUrl };
      } catch (err) {
        return { ok: false, installed: false, models: [], baseUrl: DEFAULTS.ollama.baseUrl, error: String((err as Error).message || err) };
      }
    })(),
    (async (): Promise<HarnessProbe> => {
      try {
        const data = await fetchJson<OpenAIModelList>(DEFAULTS.lmstudio.probe);
        return { ok: true, installed: true, models: idsFromOpenAI(data), baseUrl: DEFAULTS.lmstudio.baseUrl };
      } catch (err) {
        return { ok: false, installed: false, models: [], baseUrl: DEFAULTS.lmstudio.baseUrl, error: String((err as Error).message || err) };
      }
    })(),
    listGrokChatModels(),
  ]);
  cache = { at: now, value: { ollama, lmstudio, grok } };
  return cache.value;
}

export function localSpec(provider: string): LocalSpec | null {
  return DEFAULTS[provider] || null;
}
