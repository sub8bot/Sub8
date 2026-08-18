const DEFAULTS = {
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

export function isGrokChatModel(id) {
  const s = String(id || "").trim();
  if (!/^grok[-_]/i.test(s)) return false;
  if (/imagine|video|voice|image|tts|stt|whisper/i.test(s)) return false;
  return true;
}

function sortGrokModels(ids) {
  return [...new Set(ids.filter(isGrokChatModel))].sort((a, b) => {
    if (a === "grok-4.6") return -1;
    if (b === "grok-4.6") return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
}

export async function listGrokChatModels() {
  const found = new Set(GROK_CHAT_MODELS);
  const key = process.env.XAI_API_KEY || "";
  if (key) {
    try {
      const data = await fetchJson("https://api.x.ai/v1/models", 2500, {
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

let cache = { at: 0, value: null };

function idsFromOpenAI(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .filter((id) => !/embed|embedding/i.test(id));
}

async function fetchJson(url, ms = 1200, headers = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function detectLocalHarnesses({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < 5000) return cache.value;
  const [ollama, lmstudio, grok] = await Promise.all([
    (async () => {
      try {
        const data = await fetchJson(DEFAULTS.ollama.probe);
        const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
        return { ok: true, installed: true, models, baseUrl: DEFAULTS.ollama.baseUrl };
      } catch (err) {
        return { ok: false, installed: false, models: [], baseUrl: DEFAULTS.ollama.baseUrl, error: String(err.message || err) };
      }
    })(),
    (async () => {
      try {
        const data = await fetchJson(DEFAULTS.lmstudio.probe);
        return { ok: true, installed: true, models: idsFromOpenAI(data), baseUrl: DEFAULTS.lmstudio.baseUrl };
      } catch (err) {
        return { ok: false, installed: false, models: [], baseUrl: DEFAULTS.lmstudio.baseUrl, error: String(err.message || err) };
      }
    })(),
    listGrokChatModels(),
  ]);
  cache = { at: now, value: { ollama, lmstudio, grok } };
  return cache.value;
}

export function localSpec(provider) {
  return DEFAULTS[provider] || null;
}
