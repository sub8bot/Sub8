export const HARNESS_SETUP_IDS = ["grok-build", "hermes", "claude", "codex", "ollama", "lmstudio"];

export const HARNESS_INSTALL = {
  "grok-build": {
    url: "https://x.ai/cli",
    cmd: "curl -fsSL https://x.ai/cli/install.sh | bash",
    signIn: "Sign in once in the browser after install.",
  },
  hermes: {
    url: "https://hermes-agent.nousresearch.com",
    cmd: "",
    signIn: "Run hermes setup after install.",
  },
  claude: {
    url: "https://code.claude.com/docs/en/setup",
    cmd: "npm install -g @anthropic-ai/claude-code",
    signIn: "In a terminal: claude auth login",
  },
  codex: {
    url: "https://github.com/openai/codex",
    cmd: "npm install -g @openai/codex",
    signIn: "In a terminal: codex login",
  },
  ollama: {
    url: "https://ollama.com/download",
    cmd: "",
    signIn: "Start Ollama, then pull a model.",
  },
  lmstudio: {
    url: "https://lmstudio.ai",
    cmd: "",
    signIn: "Start LM Studio and load a model.",
  },
};

export const API_PRESETS = [
  {
    id: "spacexai",
    label: "xAI / Grok",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.6",
    keyHint: "xAI API key",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini",
    keyHint: "OpenRouter key",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    keyHint: "OpenAI key",
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "https://",
    model: "",
    keyHint: "API key",
  },
];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function apiPreset(id) {
  return API_PRESETS.find((p) => p.id === id) || API_PRESETS[0];
}

export function needsBrainSetup(settings, status) {
  const h = settings?.harness || {};
  if (h.setupComplete || h.setupSkipped) return false;
  if (!status?.harnesses) return true;
  const provider = h.provider || "grok-build";
  const info = status.harnesses[provider];
  if (info?.ready) return false;
  return true;
}

export function harnessAction(info) {
  if (!info) return { kind: "wait", label: "Checking…" };
  if (info.ready) return { kind: "use", label: `Use ${info.label}` };
  if (info.installed && !info.signedIn && info.id === "grok-build") return { kind: "signin", label: "Sign in" };
  if (info.installed && !info.signedIn) return { kind: "hint", label: "Sign in" };
  if (!info.installed) return { kind: "install", label: "Install" };
  return { kind: "wait", label: "Checking…" };
}

export function brainSetupHtml({
  tab = "harness",
  harnesses = {},
  catalog = [],
  api = {},
  busy = false,
  error = "",
  polling = true,
} = {}) {
  const preset = apiPreset(api.preset || "spacexai");
  const rows = (catalog.length ? catalog : HARNESS_SETUP_IDS.map((id) => ({ id, label: id })))
    .filter((item) => HARNESS_SETUP_IDS.includes(item.id))
    .map((item) => {
      const info = harnesses[item.id] || { id: item.id, label: item.label, installed: false, ready: false };
      const act = harnessAction(info);
      const tone = info.ready ? "ok" : info.installed ? "warn" : "bad";
      const status = info.ready ? "Ready" : info.installed && !info.signedIn ? "Needs sign-in" : info.installed ? "Installed" : "Not installed";
      const install = HARNESS_INSTALL[item.id] || {};
      return `<div class="brain-row" data-harness="${esc(item.id)}">
        <div>
          <strong>${esc(info.label || item.label)}</strong>
          <span class="brain-status ${tone}">${esc(status)}</span>
          <p>${esc(info.detail || install.signIn || "")}</p>
        </div>
        <button type="button" class="pill ${act.kind === "use" ? "primary" : ""}" data-act="brain-${act.kind}" data-id="${esc(item.id)}" ${busy ? "disabled" : ""}>${esc(act.label)}</button>
      </div>`;
    })
    .join("");

  const presets = API_PRESETS.map(
    (p) =>
      `<button type="button" class="pill ${p.id === preset.id ? "primary" : ""}" data-act="brain-preset" data-id="${esc(p.id)}">${esc(p.label)}</button>`,
  ).join("");

  return `<div class="overlay brain-setup" data-brain-setup="1">
    <div class="modal brain-setup-modal">
      <div class="sbody" style="width:100%">
        <h2>How should Sub8 think?</h2>
        <p class="muted">Pick a brain on this computer. You can change it later in Settings → Harness.</p>
        <div class="brain-tabs" role="tablist">
          <button type="button" class="place-btn ${tab === "harness" ? "on" : ""}" data-act="brain-tab" data-id="harness">AI Harness</button>
          <button type="button" class="place-btn ${tab === "api" ? "on" : ""}" data-act="brain-tab" data-id="api">API</button>
        </div>
        ${
          tab === "api"
            ? `<div class="brain-api">
          <div class="brain-presets">${presets}</div>
          <label class="lbl">Base URL</label>
          <input class="field" data-brain-api="baseUrl" value="${esc(api.baseUrl ?? preset.baseUrl)}" placeholder="https://api.example.com/v1" />
          <label class="lbl">API key</label>
          <input class="field" data-brain-api="apiKey" type="password" value="${esc(api.apiKey || "")}" placeholder="${esc(preset.keyHint)}" autocomplete="off" />
          <label class="lbl">Model</label>
          <input class="field" data-brain-api="model" value="${esc(api.model ?? preset.model)}" placeholder="model id" />
          <p class="muted">Any OpenAI-compatible <code>/v1/chat/completions</code> endpoint works — xAI, OpenRouter, OpenAI, or your own.</p>
          <button type="button" class="pill primary" data-act="brain-api-save" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Use this API"}</button>
        </div>`
            : `<div class="brain-list">${rows || "<p class='muted'>Checking this computer…</p>"}
          <p class="muted brain-poll">${polling ? "Checking for installs every few seconds." : ""}</p></div>`
        }
        ${error ? `<p class="muted" style="color:var(--danger)">${esc(error)}</p>` : ""}
        <div class="routine-editor-foot">
          <button type="button" class="pill" data-act="brain-later">Later</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function harnessSetupBannerHtml(info) {
  const id = info?.id || "";
  const label = esc(info?.label || "This brain");
  const installed = Boolean(info?.installed);
  const signedIn = Boolean(info?.signedIn);
  const title = !installed ? `${label} is not installed` : !signedIn ? `${label} needs a sign-in` : `${label} is not ready`;
  const detail = esc(info?.detail || (!installed ? "Install a harness on this Mac to chat." : "Finish setup to chat."));
  const cta = !installed ? "Set up" : !signedIn ? "Sign in" : "Set up";
  return `<div class="harness-strip">
    <span><strong>${title}.</strong> <span class="muted">${detail}</span></span>
    <button type="button" class="pill accent" data-act="open-brain-setup">${esc(cta)}</button>
    <button type="button" class="update-x" data-act="dismiss-harness-banner" data-id="${esc(id)}" title="Dismiss">×</button>
  </div>`;
}

export function applySimulate(status, simulate) {
  if (!status?.harnesses || !simulate) return status;
  const next = { ...status, harnesses: { ...status.harnesses } };
  const ids = simulate === "none" || simulate === "all-missing" ? HARNESS_SETUP_IDS : String(simulate).split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const row = next.harnesses[id];
    if (!row) continue;
    next.harnesses[id] = {
      ...row,
      installed: false,
      ready: false,
      signedIn: false,
      binary: row.id,
      detail: `${row.label} is not installed.`,
      hint: HARNESS_INSTALL[id]?.cmd || HARNESS_INSTALL[id]?.url || "",
    };
  }
  return next;
}
