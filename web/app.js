import { animList, bodyList, defaultAvatar, faceList, inferMood, isSleepingMood, randomWakeMood, syncAvatars } from "./avatar.js";
import { AVATAR_COLORS } from "./palette.js";

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  bots: [],
  selected: localStorage.getItem("selectedBot") || null,
  settings: null,
  timezone: "America/New_York",
  modal: null,
  section: "general",
  picker: false,
  showComputer: true,
  draft: "",
  logs: [],
  botEdit: false,
  editingRoutineId: null,
  confirmDeleteId: null,
  deskSize: "side",
  createFace: "neutral",
  createHarness: "default",
  createModel: "",
  createName: "",
  createDesc: "",
  paneWidth: Number(localStorage.getItem("paneWidth")) || 420,
  railWidth: Number(localStorage.getItem("railWidth")) || 72,
  plusMenu: false,
  humanControl: false,
  railWake: null,
  ctx: null,
  hasGrokAuth: null,
  grokAuthAsk: false,
  docker: null,
  dockerGateDismissed: false,
  update: null,
  updateBusy: false,
  updateDismissed: (() => {
    try {
      return localStorage.getItem("sub8.updateDismissed") || "";
    } catch {
      return "";
    }
  })(),
  appVersion: "",
  teach: null,
  teachFrames: [],
  attachments: [],
  vault: { groups: [], accounts: [], grants: {} },
  vaultGroup: "all",
  vaultEditId: null,
  vaultReveal: false,
  localHarness: {
    ollama: { ok: false, models: [] },
    lmstudio: { ok: false, models: [] },
    grok: { ok: true, models: ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"] },
  },
  harnessStatus: null,
  harnessTab: "grok-build",
  harnessTests: {},
  harnessBannerDismissed: {},
  computers: [],
  computerId: null,
  computerStats: {},
  computerAttach: false,
  computerView: (() => {
    try {
      return localStorage.getItem("sub8.computerView") || "grid";
    } catch {
      return "grid";
    }
  })(),
  computerSort: (() => {
    try {
      return localStorage.getItem("sub8.computerSort") || "name";
    } catch {
      return "name";
    }
  })(),
  deleteBotId: null,
  pausingQuit: false,
  previewTick: 0,
  chatFollow: true,
  chatFollowBot: null,
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function hexIcon(color, letter, extra = "") {
  return `<span class="avatar ${extra}" style="background:${color}">${letter}</span>`;
}

function letter(bot) {
  return (bot.name || "B").slice(0, 1).toUpperCase();
}

let liveFrameKey = null;
let delegated = false;

function ensureShell() {
  if ($("#shell-root")) return;
  $("#app").innerHTML = `
    <div class="frame" id="shell-root">
      <div class="titlebar" id="titlebar"></div>
      <div id="update-banner" hidden></div>
      <div id="harness-banner" hidden></div>
      <div class="shell">
        <div class="rail" id="rail"></div>
        <div class="main">
          <div class="chat" id="chat"></div>
          <div class="split" id="split" title="Drag to resize"></div>
          <aside class="pane" id="live-pane"></aside>
          <button class="monitor-fab" id="monitor-fab" data-act="expand-pane" title="Show computer" hidden>${iconMonitor()}</button>
        </div>
      </div>
      <div id="modal-host"></div>
      <div id="teach-host" hidden></div>
    </div>`;
  if (!delegated) {
    delegated = true;
    bindDelegated();
  }
}

function needsDesk(bot) {
  return Boolean(bot) && !bot.vm?.computerId && Boolean(bot.vm?.detached);
}

function noComputerHtml(bot) {
  const free = (state.computers || []).filter((c) => !c.attachedBotId);
  const list = free
    .map(
      (c) =>
        `<button type="button" class="pill" data-act="computer-attach" data-id="${c.id}" data-bot="${bot.id}">${escapeHtml(c.name)}</button>`,
    )
    .join("");
  return `<div class="screen-status desk-empty">
    <div>
      <strong>No computer attached</strong>
      <span>This Bot has no Linux desk. Attach one you already have, or start a new one.</span>
    </div>
    <div class="desk-empty-acts">
      <button type="button" class="pill primary" data-act="desk-start-new">Start a new computer</button>
      ${
        free.length
          ? `<div class="desk-empty-attach"><span class="muted">Or attach</span>${list}</div>`
          : `<span class="muted">No unattached desks. Start a new one, or detach one in Computers.</span>`
      }
    </div>
  </div>`;
}

function attachLiveFrame(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  if (needsDesk(bot)) {
    wrap.innerHTML = dockerMissing() ? `<div class="screen-status desk-empty">${dockerMissingHtml()}</div>` : noComputerHtml(bot);
    liveFrameKey = null;
    if (!dockerMissing()) {
      loadComputers().then(() => {
        const live = state.bots.find((b) => b.id === bot.id);
        if (needsDesk(live) && $("#screen-wrap")) $("#screen-wrap").innerHTML = noComputerHtml(live);
      });
    }
    return;
  }
  if (!bot?.vm?.novncPort) {
    liveFrameKey = null;
    if (dockerMissing()) {
      wrap.innerHTML = `<div class="screen-status desk-empty">${dockerMissingHtml()}</div>`;
      return;
    }
    wrap.innerHTML = `<div class="screen-status desk-empty"><div><strong>${escapeHtml(vmStatusTitle(bot))}</strong><span>${escapeHtml(
      vmStatusDetail(bot),
    )}</span></div></div>`;
    return;
  }
  const key = `${bot.id}:${bot.vm.novncPort}`;
  if (liveFrameKey !== key || !wrap.querySelector("iframe")) mountLiveFrame(bot);
  paintScreenStatus(bot);
}

function vmStatusTitle(bot) {
  if (bot?.vm?.status === "error" && bot.vm.error && !isTransientVmError(bot.vm.error)) return "Computer needs attention";
  return "Setting up the computer";
}

function isTransientVmError(msg) {
  return /app install|wget|apt|PackageKit|Unable to fetch|warming|Still setting/i.test(String(msg || ""));
}

function vmStatusDetail(bot) {
  const setup = bot?.vm?.setup;
  if (setup && setup.ready === false && setup.step) {
    return `Setting up the computer (${setup.step}/${setup.total}): ${setup.label}`;
  }
  const hint = String(bot?.vm?.hint || "").trim();
  if (hint) return hint;
  if (isTransientVmError(bot?.vm?.error)) return "Installing Chrome and tools. This can take a minute on a new computer.";
  if (bot?.vm?.error) return bot.vm.error;
  if (bot?.vm?.status === "starting") return "Waiting for the desktop…";
  return "Computer not assigned yet";
}

function paintScreenStatus(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  const iframe = wrap.querySelector("iframe");
  const st = bot?.vm?.status || "";
  const hardErr = st === "error" && bot.vm.error && !isTransientVmError(bot.vm.error);
  const boot = Boolean(bot?.vm?.setup && bot.vm.setup.ready === false);
  const installing = st === "starting" || boot;
  wrap.querySelector(".screen-status:not(.desk-empty)")?.remove();
  let chip = wrap.querySelector(".screen-chip");
  if (!iframe) {
    chip?.remove();
    return;
  }
  if (!installing && !hardErr) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.className = "screen-chip";
    wrap.appendChild(chip);
  }
  chip.textContent = vmStatusDetail(bot) || "Starting…";
  chip.classList.toggle("err", Boolean(hardErr));
}

function dockerMissing() {
  return state.docker && state.docker.ok === false;
}

function dockerStuck() {
  return Boolean(state.docker?.stuck);
}

function dockerMissingHtml() {
  const stuck = dockerStuck();
  const hint =
    state.docker?.hint ||
    (stuck
      ? "Docker stopped answering. Desks are probably still running."
      : "Please start Docker. Sub8 needs it so each Bot can have a computer.");
  return `<div class="banner warn" style="margin:0;text-align:left"><strong>${
    stuck ? "Docker is stuck." : "Docker is not running."
  }</strong> ${escapeHtml(hint)}
    <button type="button" class="pill" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
      state.dockerBusy ? "Recovering…" : "Recover"
    }</button></div>`;
}

const OFFICIAL_SITE = "https://sub8.grok.me";

function releasePageUrl() {
  return state.update?.releaseUrl || "https://github.com/sub8bot/Sub8/releases";
}

function downloadUrl() {
  return state.update?.downloadUrl || "";
}

function siteUrl() {
  return state.update?.siteUrl || OFFICIAL_SITE;
}

function dismissedThisUpdate() {
  const latest = String(state.update?.latestVersion || "").trim();
  return Boolean(latest && state.updateDismissed === latest);
}

function paintUpdateBanner() {
  let host = $("#update-banner");
  if (!host) {
    const bar = $("#titlebar");
    host = document.createElement("div");
    host.id = "update-banner";
    if (bar?.parentNode) bar.after(host);
    else document.body.appendChild(host);
  }
  const u = state.update;
  if (!u?.updateAvailable || dismissedThisUpdate()) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  const file = downloadUrl();
  const label = u.downloadName ? `Download ${u.downloadName}` : "Download";
  host.hidden = false;
  host.innerHTML = `<div class="update-strip">
    <span>Sub8 ${escapeHtml(u.latestVersion || "")} is available
    <span class="muted">(you have ${escapeHtml(u.currentVersion || "")})</span></span>
    ${file ? `<a class="update-link" href="${escapeHtml(file)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>` : ""}
    <a class="update-link" href="${escapeHtml(siteUrl())}" target="_blank" rel="noopener">sub8.grok.me</a>
    <button type="button" class="update-x" data-act="dismiss-update" title="Dismiss">×</button>
  </div>`;
}

async function runningAppVersion() {
  try {
    const v = await window.sub8Desktop?.version?.();
    if (v) return String(v);
  } catch {
    /* unpackaged or no handler */
  }
  return state.appVersion || "";
}

async function checkForUpdate({ silent = true } = {}) {
  try {
    const desktop = window.sub8Desktop;
    const current = (await runningAppVersion()) || state.appVersion || "";
    let info = await api(`/api/update${current ? `?current=${encodeURIComponent(current)}` : ""}`);
    if (current) info = { ...info, currentVersion: current };
    if (desktop?.checkUpdate) {
      const native = await Promise.race([
        desktop.checkUpdate().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]);
      if (native?.currentVersion) info.currentVersion = native.currentVersion;
      if (native?.updateAvailable && native.latestVersion && info.downloadUrl) {
        info = {
          ...info,
          latestVersion: native.latestVersion,
          updateAvailable: true,
          error: null,
        };
      }
      if (!info.downloadUrl) info.updateAvailable = false;
    }
    state.update = { ...info, justChecked: !silent };
    if (info.currentVersion) state.appVersion = info.currentVersion;
    paintUpdateBanner();
    if (state.modal === "settings") paintModal();
    return info;
  } catch (err) {
    state.update = {
      currentVersion: state.appVersion || "",
      updateAvailable: false,
      error: err.message,
      justChecked: !silent,
    };
    if (!silent && state.modal === "settings") paintModal();
    return state.update;
  }
}

function openExternal(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener");
}

function openDownload() {
  openExternal(downloadUrl() || releasePageUrl());
  if (state.modal) {
    state.modal = null;
    render();
  }
}

function openOfficialSite() {
  openExternal(siteUrl());
  if (state.modal) {
    state.modal = null;
    render();
  }
}

function dismissUpdateBanner() {
  const latest = String(state.update?.latestVersion || "").trim();
  if (latest) {
    state.updateDismissed = latest;
    try {
      localStorage.setItem("sub8.updateDismissed", latest);
    } catch {
      /* ignore quota / private mode */
    }
  }
  paintUpdateBanner();
}

function paintDockerGate() {
  let host = $("#docker-gate");
  if (!host) {
    host = document.createElement("div");
    host.id = "docker-gate";
    document.body.appendChild(host);
  }
  if (!dockerMissing()) {
    state.dockerGateDismissed = false;
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  if (state.dockerGateDismissed) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const stuck = dockerStuck();
  host.innerHTML = `<div class="overlay docker-gate-overlay">
    <div class="modal" style="max-width:440px" data-modal="1">
      <div class="sbody" style="width:100%">
        <button type="button" class="close" data-act="dismiss-docker-gate">×</button>
        <h2>${stuck ? "Docker is stuck" : "Start Docker"}</h2>
        <p>${
          stuck
            ? "Your desks are probably still running. Docker (Colima on this Mac, or Docker Desktop) stopped answering, so Sub8 cannot see them."
            : "A Bot’s computer needs Docker (Colima on a Mac, or Docker Desktop). Chat still works without it."
        }</p>
        <p class="muted">${escapeHtml(state.docker?.hint || "")}</p>
        <div class="routine-editor-foot">
          <button type="button" class="pill primary" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
            state.dockerBusy ? "Recovering…" : "Recover Docker"
          }</button>
          <button type="button" class="pill" data-act="dismiss-docker-gate">Continue anyway</button>
        </div>
      </div>
    </div>
  </div>`;
}

function streamUrl(bot) {
  const t = Date.now();
  return `http://127.0.0.1:${bot.vm.novncPort}/?autoconnect=1&reconnect=1&reconnect_delay=1500&resize=scale&t=${t}`;
}

const lastGoodScreen = new Map();

function bindStill(img, botId) {
  if (!img) return;
  img.addEventListener("load", () => {
    if (img.naturalWidth > 1) {
      lastGoodScreen.set(botId, img.currentSrc || img.src);
      img.hidden = false;
      img.classList.remove("broken");
    }
  });
  img.addEventListener("error", () => {
    const keep = lastGoodScreen.get(botId);
    if (keep && img.src !== keep) {
      img.src = keep;
      return;
    }
    img.removeAttribute("src");
    img.hidden = true;
    img.classList.add("broken");
  });
}

async function refreshStill(img, botId) {
  if (!img || !botId) return;
  try {
    const res = await fetch(`/api/bots/${botId}/screen?t=${Date.now()}`);
    if (!res.ok) throw new Error("no still");
    const blob = await res.blob();
    if (!blob.size || blob.size < 80) throw new Error("empty still");
    const url = URL.createObjectURL(blob);
    const prev = lastGoodScreen.get(botId);
    lastGoodScreen.set(botId, url);
    img.src = url;
    img.hidden = false;
    img.classList.remove("broken", "hidden");
    if (prev && prev.startsWith("blob:") && prev !== url) {
      setTimeout(() => URL.revokeObjectURL(prev), 4000);
    }
  } catch {
    const keep = lastGoodScreen.get(botId);
    if (keep) {
      if (img.src !== keep) img.src = keep;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
}

function mountLiveFrame(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap || !bot?.vm?.novncPort) return;
  const key = `${bot.id}:${bot.vm.novncPort}`;
  liveFrameKey = key;
  delete wrap.dataset.empty;
  delete wrap.dataset.streamReady;
  const keep = lastGoodScreen.get(bot.id) || "";
  wrap.innerHTML = `<img class="screen-still${keep ? "" : " hidden"}" alt="" ${
    keep ? `src="${keep}"` : ""
  } /><iframe data-key="${key}" src="${streamUrl(bot)}" allow="clipboard-read; clipboard-write"></iframe>`;
  const iframe = wrap.querySelector("iframe");
  const still = wrap.querySelector(".screen-still");
  bindStill(still, bot.id);
  if (keep) still.hidden = false;
  refreshStill(still, bot.id);
  const label = $("#screen-label");
  iframe?.addEventListener("load", () => {
    wrap.dataset.streamReady = "1";
    if (label) label.textContent = `${bot.name}'s screen`;
    const live = state.bots.find((b) => b.id === bot.id) || bot;
    paintScreenStatus(live);
    setTimeout(() => {
      if (still?.parentNode === wrap) still.classList.add("hidden");
    }, 1400);
  });
  iframe?.addEventListener("error", () => scheduleStreamRetry(bot, 1600));
  if (!wrap.dataset.kicked) {
    wrap.dataset.kicked = "1";
    scheduleStreamRetry(bot, 2200);
  }
  paintControlChrome();
}

let streamRetry = 0;
function scheduleStreamRetry(bot, ms) {
  clearTimeout(streamRetry);
  streamRetry = setTimeout(() => {
    if (state.selected !== bot.id || !bot.vm?.novncPort) return;
    const wrap = $("#screen-wrap");
    const iframe = wrap?.querySelector("iframe");
    if (iframe) {
      iframe.src = streamUrl(bot);
      const still = wrap.querySelector(".screen-still");
      if (still) {
        still.classList.remove("hidden");
        refreshStill(still, bot.id);
      }
      return;
    }
    liveFrameKey = null;
    mountLiveFrame(bot);
  }, ms);
}

function rememberSelected(id) {
  state.selected = id || null;
  try {
    if (id) localStorage.setItem("selectedBot", id);
    else localStorage.removeItem("selectedBot");
  } catch {
    /* ignore */
  }
}

function unionClientMessages(a = [], b = []) {
  const byId = new Map();
  for (const m of a) if (m?.id) byId.set(m.id, m);
  for (const m of b) if (m?.id) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
}

const forgottenBots = new Set();
const forgottenMessages = new Set();

function adoptBot(next) {
  if (!next?.id || forgottenBots.has(next.id)) return next;
  const i = state.bots.findIndex((b) => b.id === next.id);
  if (i < 0) {
    next.messages = Array.isArray(next.messages) ? next.messages : [];
    state.bots.push(next);
    return next;
  }
  const prev = state.bots[i];
  next.messages = unionClientMessages(next.messages, prev.messages).filter(
    (m) => !forgottenMessages.has(`${next.id}:${m.id}`),
  );
  state.bots[i] = { ...prev, ...next, messages: next.messages };
  if (typeof next.busy === "boolean") state.bots[i].busy = next.busy;
  return state.bots[i];
}

function syncBots(incoming) {
  const list = Array.isArray(incoming) ? incoming : [];
  const seen = new Set(list.map((b) => b.id).filter(Boolean));
  for (const id of seen) forgottenBots.delete(id);
  for (const b of list) adoptBot(b);
  state.bots = state.bots.filter((b) => seen.has(b.id));
  if (state.selected && !seen.has(state.selected)) {
    rememberSelected(state.bots.find((b) => !b.hidden)?.id || null);
  }
}

async function stopTurn() {
  const id = state.selected;
  if (!id) return;
  const bot = state.bots.find((b) => b.id === id);
  if (bot) {
    bot.busy = false;
    paintChat(bot);
  }
  try {
    await api(`/api/bots/${id}/stop`, { method: "POST", body: {} });
  } catch {
    /* ignore */
  }
}

async function loadBotHistory(id) {
  if (!id) return;
  try {
    const bot = await api(`/api/bots/${id}`);
    adoptBot(bot);
    if (state.selected === id) {
      paintChat(state.bots.find((b) => b.id === id));
      refreshAvatars();
    }
  } catch {
    /* keep whatever we already have */
  }
}

function paintChat(bot) {
  const thread = $("#thread");
  if (!thread || !bot) return;
  if (!Array.isArray(bot.messages)) bot.messages = [];
  if (state.chatFollowBot !== bot.id) {
    state.chatFollowBot = bot.id;
    state.chatFollow = true;
  }
  const rows = bot.messages.filter((m) => !m.hidden && m.role !== "tool");
  if (!rows.length && !bot.busy) {
    thread.innerHTML = `<div class="empty">Message ${escapeHtml(bot.name)} to put it to work.</div>`;
    return;
  }
  const html = [];
  for (let i = 0; i < rows.length; ) {
    const m = rows[i];
    if (m.role === "user") {
      html.push(`<div class="bubble user" data-mid="${escapeHtml(m.id || "")}">${escapeHtml(m.content)}</div>`);
      i += 1;
      continue;
    }
    if (m.kind === "think" || m.kind === "tool" || m.role === "activity") {
      const batch = [];
      while (i < rows.length && (rows[i].kind === "think" || rows[i].kind === "tool" || rows[i].role === "activity")) {
        const next = rows[i];
        const gap = (Number(next.ts) || 0) - (Number(batch.at(-1)?.ts) || Number(next.ts) || 0);
        if (batch.length && (gap > 45_000 || batch.length >= 24)) break;
        batch.push(next);
        i += 1;
      }
      html.push(renderActivity(batch, Boolean(bot.busy && i >= rows.length)));
      continue;
    }
    if (String(m.content || "").trim()) {
      html.push(`<div class="bubble" data-mid="${escapeHtml(m.id || "")}">${formatChatText(m.content)}</div>`);
    }
    i += 1;
  }
  if (bot.busy) {
    html.push(`<div class="working"><span class="working-dot"></span>Working…</div>`);
  }
  thread.innerHTML = html.join("");
  if (state.chatFollow) thread.scrollTop = thread.scrollHeight;
  const go = $(".composer-go");
  const halt = $(".composer [data-act=stop-turn]");
  if (go) go.hidden = false;
  if (halt) halt.hidden = !bot.busy;
}

function activityKey(m) {
  if (m.kind === "think") return "think";
  const act = m.action || m.name || "";
  if (act === "key" || act === "type") return `${act}:${m.summary || ""}`;
  return act || m.summary || "work";
}

function renderActivity(batch, openLast) {
  const thoughts = batch.filter((m) => m.kind === "think");
  const tools = batch.filter((m) => m.kind !== "think");
  const order = [];
  const byKey = new Map();
  for (const m of tools) {
    const key = activityKey(m);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key).push(m);
  }
  const parts = [];
  for (const key of order) {
    const items = byKey.get(key);
    const first = items[0];
    const n = items.length;
    const label = first.summary || first.action || first.name || "Working";
    const text = n > 1 ? `${label} ×${n}` : label;
    parts.push(`<div class="tool-row">${toolIcon(first.action || first.name)}<span>${escapeHtml(text)}</span></div>`);
  }
  if (thoughts.length) {
    const body = thoughts.map((t) => t.content).filter(Boolean).at(-1) || "";
    parts.push(`<details class="thought"${openLast ? " open" : ""}>
      <summary>Thought</summary>
      <div class="thought-body">${formatChatText(body)}</div>
    </details>`);
  }
  const mids = batch.map((m) => m.id).filter(Boolean).join(",");
  return `<div class="tool-list" data-mids="${escapeHtml(mids)}">${parts.join("")}</div>`;
}

function formatChatText(raw) {
  let s = escapeHtml(raw ?? "");
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="chat-code">${code.trim()}</pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, `$1<a href="$2" target="_blank" rel="noreferrer">$2</a>`);
  return s;
}

function toolIcon(action) {
  const a = String(action || "");
  const svg = (d) =>
    `<svg class="tool-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (a === "screenshot" || a === "computer") return svg(`<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/>`);
  if (/click|mouse|drag/.test(a)) return svg(`<path d="M4 4l7 16 2-6 6-2z"/>`);
  if (a === "type" || a === "key") return svg(`<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>`);
  if (a === "web_search") return svg(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`);
  if (a === "shell") return svg(`<path d="M4 17l6-5-6-5M12 19h8"/>`);
  if (a.includes("routine")) return svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`);
  if (a === "scroll") return svg(`<path d="M12 5v14M8 9l4-4 4 4M8 15l4 4 4-4"/>`);
  return svg(`<circle cx="12" cy="12" r="3"/>`);
}

function render() {
  ensureShell();
  applyDeskSize();
  const bot = state.bots.find((b) => b.id === state.selected) || state.bots[0];
  paintTitle(bot);
  paintRail(bot);
  paintChatPane(bot);
  paintLivePane(bot);
  paintModal();
  paintTeach(bot);
  paintCtxMenu();
  paintGrokAuth();
  paintHarnessBanner();
  syncEditorChips(bot);
  refreshAvatars();
}

function refreshAvatars() {
  const items = [...document.querySelectorAll("[data-avatar]")].flatMap((el) => {
    const id = el.dataset.avatar;
    const bot = state.bots.find((b) => b.id === id);
    if (!bot && id !== "create") return [];
    const preview = el.dataset.preview === "1";
    const wake = state.railWake;
    const mood =
      id === "create"
        ? defaultAvatar({ expression: state.createFace, animation: "idle" })
        : wake && wake.id === id && (el.dataset.avatarSlot || "") === "rail" && Date.now() < wake.until
          ? wake.mood
          : inferMood(bot, { preview });
    const slot = el.dataset.avatarSlot || "default";
    const framing =
      el.dataset.avatarFraming || (slot === "editor" || slot === "create" ? "body" : "icon");
    return [
      {
        el,
        id,
        slot,
        size: Number(el.dataset.avatarSize || 36),
        color: bot?.color || AVATAR_COLORS[0],
        framing,
        body: defaultAvatar(bot?.avatar).body,
        mood,
      },
    ];
  });
  syncAvatars(items);
}

function applyDeskSize() {
  const frame = $("#shell-root");
  if (!frame) return;
  const size = state.teach || state.deskSize === "full" ? "full" : "side";
  const collapsed = !state.showComputer && !state.botEdit && size !== "full" && !state.teach;
  frame.classList.remove("desk-side", "desk-wide", "desk-full", "pane-collapsed");
  frame.classList.add("desk-" + size);
  if (collapsed) frame.classList.add("pane-collapsed");
  const chat = $("#chat");
  if (chat) {
    const hide = size === "full" && !state.botEdit;
    chat.hidden = hide;
    chat.style.display = hide ? "none" : "";
  }
  let fab = $("#monitor-fab");
  if (!fab) {
    const main = $(".main");
    if (main) {
      fab = document.createElement("button");
      fab.className = "monitor-fab";
      fab.id = "monitor-fab";
      fab.dataset.act = "expand-pane";
      fab.title = "Show computer";
      fab.innerHTML = iconMonitor();
      main.appendChild(fab);
    }
  }
  if (fab) fab.hidden = true;
  applyPaneWidth();
  applyRailWidth();
  bindSplit();
  bindRailResize();
}

function applyPaneWidth() {
  const frame = $("#shell-root");
  if (!frame) return;
  const w = Math.round(state.paneWidth || 420);
  frame.style.setProperty("--pane-w", `${w}px`);
}

function applyRailWidth() {
  const w = Math.round(Math.min(248, Math.max(68, state.railWidth || 72)));
  document.documentElement.style.setProperty("--sidebar", `${w}px`);
}

function bindRailResize() {
  const rail = $("#rail");
  if (!rail) return;
  let handle = $("#rail-resize");
  if (!handle) {
    handle = document.createElement("div");
    handle.id = "rail-resize";
    handle.className = "rail-resize";
    handle.title = "Drag to resize sidebar";
    rail.appendChild(handle);
  }
  if (handle.dataset.ready) return;
  handle.dataset.ready = "1";
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rail.getBoundingClientRect().width;
    handle.classList.add("dragging");
    const onMove = (ev) => {
      state.railWidth = Math.min(248, Math.max(68, startW + (ev.clientX - startX)));
      applyRailWidth();
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem("railWidth", String(Math.round(state.railWidth)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function bindSplit() {
  const main = $(".main");
  if (!main) return;
  let split = $("#split");
  if (!split) {
    split = document.createElement("div");
    split.id = "split";
    split.className = "split";
    split.title = "Drag to resize";
    const pane = $("#live-pane");
    if (pane) main.insertBefore(split, pane);
    else main.appendChild(split);
  }
  if (split.dataset.ready) return;
  split.dataset.ready = "1";
  split.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const pane = $("#live-pane");
    if (!pane || pane.hidden) return;
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const mainW = main.getBoundingClientRect().width;
    split.classList.add("dragging");
    const onMove = (ev) => {
      const next = Math.min(Math.max(startW + (startX - ev.clientX), 280), Math.max(280, mainW - 280));
      state.paneWidth = next;
      applyPaneWidth();
    };
    const onUp = () => {
      split.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem("paneWidth", String(Math.round(state.paneWidth)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function iconClose() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
}

function iconHarness() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>`;
}

function iconUsage() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="4" height="10" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/></svg>`;
}

function iconLock() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
}

function iconComputer() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`;
}

function iconGear() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7 1 1.2 1.7 1.3H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1.7z"/></svg>`;
}

function iconChevrons() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5l7 7-7 7"/><path d="M6 5l7 7-7 7"/></svg>`;
}

function iconBack() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
}

function iconMonitor() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
}

function iconExpand() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
}

function iconStop() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
}

function iconPlus() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
}

function iconMic() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
}

function iconSend() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
}

function iconClock() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
}

function resolvedHarness(bot) {
  const global = state.settings?.harness || {};
  const local = bot?.harness || {};
  const provider =
    local.provider && local.provider !== "default" ? local.provider : global.provider || "grok-build";
  let model = (local.model && String(local.model).trim()) || "";
  if (!model && global.provider === provider) model = String(global.model || "").trim();
  if (!model) {
    if (provider === "claude" || provider === "codex" || provider === "hermes") model = "default";
    else if (provider === "grok-build" || provider === "spacexai") model = "grok-4.6";
    else model = provider;
  }
  return { provider, model };
}

function paintTitle(bot) {
  const { provider, model } = resolvedHarness(bot);
  const bar = $("#titlebar");
  const collapsed = !state.showComputer && !state.botEdit && state.deskSize !== "full";
  const runningN = (state.computers || []).filter((c) => c.status === "running").length;
  const stamp = `${bot?.id || ""}|${state.botEdit ? "1" : "0"}|${state.deskSize}|${collapsed ? "1" : "0"}|c${runningN}`;
  if (bar.dataset.stamp === stamp && bar.querySelector("[data-act=vault]") && bar.querySelector("[data-act=computers]")) {
    const name = bar.querySelector(".botname-btn .bot-label");
    if (name && bot) name.textContent = bot.name;
    const chip = bar.querySelector(".harness-chip");
    if (chip) chip.textContent = `${provider} · ${model}`;
    return;
  }
  bar.dataset.stamp = stamp;
  const collapseAct = state.deskSize === "full" ? "collapse-full" : "collapse-pane";
  bar.innerHTML = `
    <div class="botname">${
      bot
        ? `<button class="botname-btn" data-act="bot-settings" title="Bot settings">
            <span class="avatar sm" data-avatar="${bot.id}" data-avatar-slot="title" data-avatar-size="32" data-avatar-framing="body"></span>
            <span class="bot-label">${escapeHtml(bot.name)}</span>
          </button>`
        : "Sub8"
    }
      <span class="muted harness-chip">${escapeHtml(provider)} · ${escapeHtml(model)}</span>
    </div>
    <div class="spacer"></div>
    <div class="title-actions">
      <button class="iconbtn computer-btn" data-act="computers" title="Computers">${iconComputer()}${
        runningN ? `<span class="computer-badge">${runningN}</span>` : ""
      }</button>
      <button class="iconbtn" data-act="vault" title="Password vault">${iconLock()}</button>
      ${
        !bot
          ? `<button class="iconbtn" data-act="settings" title="Settings">${iconGear()}</button>`
          : collapsed
            ? `<button class="monitor-fab title-monitor" data-act="expand-pane" title="Show computer">${iconMonitor()}</button>`
            : `<button class="iconbtn" data-act="bot-settings" title="Bot settings">${iconGear()}</button>
               <button class="iconbtn" data-act="${collapseAct}" title="Collapse">${iconChevrons()}</button>`
      }
    </div>`;
}

function sidebarSections() {
  return Array.isArray(state.settings?.sidebarSections) ? state.settings.sidebarSections : [];
}

function railLayout() {
  const vis = state.bots.filter((b) => !b.hidden);
  const pinned = vis.filter((b) => b.pinned);
  const rest = vis.filter((b) => !b.pinned);
  const sections = sidebarSections();
  const known = new Set(sections.map((s) => s.id));
  const groups = sections.map((s) => ({
    id: s.id,
    name: s.name,
    bots: rest.filter((b) => b.section === s.id),
  }));
  const loose = rest.filter((b) => !b.section || !known.has(b.section));
  groups.push({ id: "", name: groups.length ? "Unassigned" : "", bots: loose });
  return { pinned, groups };
}

function ensureRailNode(b) {
  const node = document.createElement("div");
  node.className = "rail-bot";
  node.dataset.id = b.id;
  node.draggable = true;
  node.innerHTML = `
    <button class="avatar" data-act="select" data-id="${b.id}">
      <span class="avatar-3d" data-avatar="${b.id}" data-avatar-slot="rail" data-avatar-size="56" data-avatar-framing="body"></span>
      <i class="rail-unread" hidden></i>
    </button>`;
  return node;
}

function paintRail(bot) {
  const rail = $("#rail");
  if (rail.dataset.ready !== "scroll") {
    rail.innerHTML = `
      <button class="plus" data-act="create" title="Create new Bot">+</button>
      <div class="rail-bots" id="rail-bots"></div>
      <button class="me" data-act="profile" title="App settings"></button>
      <div class="rail-resize" id="rail-resize" title="Drag to resize sidebar"></div>`;
    rail.dataset.ready = "scroll";
    bindRailResize();
  }
  const host = $("#rail-bots");
  const { pinned, groups } = railLayout();
  const keep = new Set(state.bots.map((b) => b.id));
  const nodes = new Map();
  for (const node of [...host.querySelectorAll(".rail-bot")]) {
    if (!keep.has(node.dataset.id) || state.bots.find((b) => b.id === node.dataset.id)?.hidden) node.remove();
    else nodes.set(node.dataset.id, node);
  }
  host.innerHTML = "";
  const addBot = (b) => {
    let node = nodes.get(b.id) || ensureRailNode(b);
    node.querySelector(".rail-edit")?.remove();
    node.draggable = true;
    const btn = node.querySelector(".avatar");
    btn.draggable = true;
    btn.classList.toggle("active", b.id === bot?.id);
    btn.classList.toggle("busy", Boolean(b.busy || b.vm?.status === "starting"));
    btn.classList.toggle("pinned", Boolean(b.pinned));
    const unread = node.querySelector(".rail-unread");
    if (unread) unread.hidden = !b.unread;
    btn.title = b.name;
    host.appendChild(node);
  };
  if (pinned.length) {
    host.appendChild(sectionTag("pinned", "Pinned"));
    for (const b of pinned) addBot(b);
  }
  for (const g of groups) {
    if (g.name || g.bots.length) {
      host.appendChild(sectionTag(g.id, g.name || "Unassigned"));
    }
    for (const b of g.bots) addBot(b);
  }
  bindRailHover(host);
  bindRailDnD(host);
}

function isNamedSection(id) {
  return Boolean(id && id !== "pinned");
}

function sectionTag(id, name) {
  const tag = document.createElement("div");
  tag.className = "rail-sec";
  tag.dataset.sec = id || "";
  tag.title = isNamedSection(id) ? `${name} · right-click to rename` : name;
  tag.innerHTML = `<span>${escapeHtml(name)}</span>`;
  if (isNamedSection(id)) tag.classList.add("editable");
  return tag;
}

function bindRailHover(host) {
  if (host.dataset.hover) return;
  host.dataset.hover = "1";
  host.addEventListener("pointerenter", (e) => {
    const row = e.target.closest(".rail-bot");
    if (!row || !host.contains(row)) return;
    const bot = state.bots.find((b) => b.id === row.dataset.id);
    if (!bot) return;
    const mood = inferMood(bot);
    if (!isSleepingMood(mood)) return;
    state.railWake = { id: bot.id, mood: randomWakeMood(), until: Date.now() + 8_000 };
    refreshAvatars();
  }, true);
  host.addEventListener("pointerleave", (e) => {
    const row = e.target.closest(".rail-bot");
    if (!row || e.relatedTarget?.closest?.(".rail-bot") === row) return;
    if (state.railWake?.id === row.dataset.id) {
      state.railWake.until = Date.now() + 1_200;
      setTimeout(() => refreshAvatars(), 1_250);
    }
  }, true);
}

function bindRailDnD(host) {
  if (host.dataset.dnd) return;
  host.dataset.dnd = "1";
  host.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".rail-bot");
    if (!row) return;
    e.dataTransfer.setData("text/sub8bot-id", row.dataset.id);
    e.dataTransfer.setData("text/plain", row.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  host.addEventListener("dragend", (e) => {
    e.target.closest(".rail-bot")?.classList.remove("dragging");
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
  });
  host.addEventListener("dragover", (e) => {
    if (
      ![...e.dataTransfer.types].includes("text/sub8bot-id") &&
      ![...e.dataTransfer.types].includes("text/octobot-id") &&
      ![...e.dataTransfer.types].includes("text/plain")
    ) {
      /* keep allowing */
    }
    e.preventDefault();
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
    const sec = e.target.closest(".rail-sec");
    const bot = e.target.closest(".rail-bot");
    (sec || bot)?.classList.add("drag-over");
  });
  host.addEventListener("drop", (e) => {
    e.preventDefault();
    host.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
    const id =
      e.dataTransfer.getData("text/sub8bot-id") ||
      e.dataTransfer.getData("text/octobot-id") ||
      e.dataTransfer.getData("text/plain");
    if (!id) return;
    const secEl = e.target.closest(".rail-sec");
    const onto = e.target.closest(".rail-bot");
    let section = "";
    let pinned = false;
    if (secEl) {
      const sid = secEl.dataset.sec || "";
      if (sid === "pinned") pinned = true;
      else section = sid;
    } else if (onto) {
      const other = state.bots.find((b) => b.id === onto.dataset.id);
      if (other?.pinned) pinned = true;
      else section = other?.section || "";
    }
    moveBotTo(id, { section, pinned });
  });
}

function moveBotTo(id, { section = "", pinned = false } = {}) {
  const b = state.bots.find((x) => x.id === id);
  if (!b) return;
  b.section = section;
  b.pinned = pinned;
  api(`/api/bots/${id}`, { method: "PATCH", body: { section, pinned } });
  render();
}

function paintChatPane(bot) {
  const chat = $("#chat");
  if (!bot) {
    chat.innerHTML = `<div class="empty">Create a Bot to get started.</div>`;
    return;
  }
  if (!$("#thread") || !$("#send textarea[name=q]") || !$(".composer-mic") || !$(".chat-head") || $(".chat-stop") || document.querySelector("[data-act=picker]")) {
    chat.innerHTML = `
      <div class="chat-head">
        <span class="chat-head-name">${escapeHtml(bot.name)}</span>
        <div class="chat-head-actions">
          <button type="button" class="pill chat-advanced" data-act="advanced">Advanced</button>
        </div>
      </div>
      <div class="thread" id="thread"></div>
      <div class="composer">
        <form class="input" id="send">
          <button type="button" class="composer-plus" data-act="plus-menu" title="Add">${iconPlus()}</button>
          <textarea name="q" rows="1" placeholder="Message ${escapeHtml(bot.name)}"></textarea>
          <button type="button" class="composer-send composer-stop" data-act="stop-turn" hidden title="Stop">${iconStop()}</button>
          <button type="button" class="composer-mic" data-act="dictate" title="Speak">${iconMic()}</button>
          <button type="submit" class="composer-send composer-go" title="Send">${iconSend()}</button>
        </form>
        <div class="composer-hint">Enter to send · Shift+Enter for a new line</div>
        <input id="attach-file" type="file" multiple hidden />
      </div>
      <div id="picker-host"></div>`;
    $("#send").addEventListener("submit", onSend);
    $("#attach-file")?.addEventListener("change", onAttachFiles);
    const box = $("#send")?.q;
    if (box) {
      box.addEventListener("keydown", onComposerKey);
      box.addEventListener("input", sizeComposer);
    }
    const thread = $("#thread");
    if (thread && !thread.dataset.followBound) {
      thread.dataset.followBound = "1";
      thread.addEventListener(
        "scroll",
        () => {
          const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
          state.chatFollow = gap < 80;
        },
        { passive: true },
      );
    }
    sizeComposer();
  } else {
    const input = $("#send")?.q;
    if (input) input.placeholder = `Message ${bot.name}`;
    const hn = $(".chat-head-name");
    if (hn) hn.textContent = bot.name;
    const go = $(".composer-go");
    const halt = $(".composer [data-act=stop-turn]");
    if (go) go.hidden = false;
    if (halt) halt.hidden = !bot.busy;
  }
  paintChat(bot);
  const ph = $("#picker-host");
  if (ph) {
    const bits = [];
    if (state.attachments.length) bits.push(attachChipsHtml());
    if (state.plusMenu) bits.push(plusMenuHtml());
    ph.innerHTML = bits.join("");
  }
}

function iconClip() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.6l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5L10.1 18.7a2 2 0 1 1-2.8-2.8l8.5-8.5"/></svg>`;
}

function iconRecord() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="#e11d48"><circle cx="12" cy="12" r="7"/></svg>`;
}

function plusMenuHtml() {
  return `<div class="plus-menu">
    <button type="button" data-act="attach-files">${iconClip()} Attach files</button>
    <button type="button" data-act="teach-task">${iconRecord()} Teach a task</button>
  </div>`;
}

function attachChipsHtml() {
  return `<div class="attach-chips">${state.attachments
    .map(
      (a, i) =>
        `<span class="attach-chip">${escapeHtml(a.name)}<button type="button" data-act="drop-attach" data-i="${i}">×</button></span>`,
    )
    .join("")}</div>`;
}

function paintTeach(bot) {
  let host = $("#teach-host");
  if (!host) {
    const frame = $("#shell-root");
    if (!frame) return;
    host = document.createElement("div");
    host.id = "teach-host";
    frame.appendChild(host);
  }
  if (!state.teach || !bot) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const rec = state.teach === "recording";
  host.innerHTML = `
    <div class="teach-banner">
      <p>${
        rec
          ? `Recording… Do the task on ${escapeHtml(bot.name)}’s computer.`
          : `Record yourself doing a task. ${escapeHtml(bot.name)} learns the steps and can run them again on its own.`
      }</p>
      <button type="button" class="teach-rec ${rec ? "on" : ""}" data-act="${rec ? "stop-teach" : "start-teach"}">
        ${iconRecord()} ${rec ? "Stop recording" : "Start recording"}
      </button>
      <button type="button" class="teach-x" data-act="close-teach" title="Close">×</button>
    </div>
    <p class="teach-foot">You are driving ${escapeHtml(bot.name)}’s computer.</p>`;
}

function ctxIcon(kind) {
  const svg = (d) =>
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (kind === "pin") return svg(`<path d="M12 17v5M8 3h8l-1 7h3l-6 7-6-7h3z"/>`);
  if (kind === "folder") return svg(`<path d="M3 7h6l2 2h10v10H3z"/>`);
  if (kind === "unread") return svg(`<path d="M18 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0z"/><path d="M12 14v7"/>`);
  if (kind === "edit") return svg(`<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`);
  if (kind === "dup") return svg(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>`);
  if (kind === "copy") return svg(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>`);
  if (kind === "hide") return svg(`<path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.1A10 10 0 0 1 21 12c-1 1.8-2.4 3.3-4.1 4.4M6.1 6.1C4.4 7.2 3 8.7 2 12c1.6 2.8 4.4 5 8 6.1"/>`);
  if (kind === "del") return svg(`<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>`);
  if (kind === "plus") return svg(`<path d="M12 5v14M5 12h14"/><path d="M4 7h6l2 2"/>`);
  return "";
}

function paintCtxMenu() {
  let host = $("#ctx-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "ctx-host";
    document.body.appendChild(host);
  }
  const ctx = state.ctx;
  if (!ctx) {
    host.innerHTML = "";
    return;
  }
  if (ctx.type === "section") {
    const sec = sidebarSections().find((s) => s.id === ctx.secId);
    if (!sec) {
      host.innerHTML = "";
      return;
    }
    const left = Math.min(ctx.x, window.innerWidth - 240);
    const top = Math.min(ctx.y, window.innerHeight - 180);
    if (ctx.naming) {
      host.innerHTML = `<div class="ctx-prompt" style="top:${top}px;left:${left}px">
        <input id="ctx-sec-name" class="field" value="${escapeHtml(sec.name)}" placeholder="Section name" />
        <button type="button" class="pill primary" data-act="ctx-rename-section" data-sec="${escapeHtml(sec.id)}">Save</button>
      </div>`;
      setTimeout(() => {
        const input = $("#ctx-sec-name");
        if (!input) return;
        input.focus();
        input.select();
      }, 20);
      return;
    }
    host.innerHTML = `<div class="ctx-menu" style="top:${top}px;left:${left}px">
      <button type="button" class="ctx-item" data-act="ctx-rename-section-open" data-sec="${escapeHtml(sec.id)}">${ctxIcon("edit")}<span>Rename section</span></button>
      <button type="button" class="ctx-item ctx-danger" data-act="ctx-delete-section" data-sec="${escapeHtml(sec.id)}">${ctxIcon("del")}<span>Delete section</span></button>
    </div>`;
    return;
  }
  if (ctx.type === "message") {
    const left = Math.min(ctx.x, window.innerWidth - 220);
    const top = Math.min(ctx.y, window.innerHeight - 80);
    host.innerHTML = `<div class="ctx-menu" style="top:${top}px;left:${left}px">
      <button type="button" class="ctx-item ctx-danger" data-act="ctx-del-msg">${ctxIcon("del")}<span>Delete message</span></button>
    </div>`;
    return;
  }
  const bot = state.bots.find((b) => b.id === ctx.botId);
  if (!bot) {
    host.innerHTML = "";
    return;
  }
  const sections = sidebarSections();
  const left = Math.min(ctx.x, window.innerWidth - 240);
  const top = Math.min(ctx.y, window.innerHeight - 340);
  const item = (act, icon, label, extra = "") =>
    `<button type="button" class="ctx-item ${extra}" data-act="${act}" data-id="${bot.id}">${ctxIcon(icon)}<span>${label}</span></button>`;
  let move = "";
  if (ctx.sub === "move") {
    move = `<div class="ctx-sub" style="top:${top}px;left:${left + 228}px">
      <button type="button" class="ctx-item" data-act="ctx-new-section" data-id="${bot.id}">${ctxIcon("plus")}<span>New section</span></button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item ${!bot.section ? "on" : ""}" data-act="ctx-move" data-id="${bot.id}" data-sec="">${ctxIcon("folder")}<span>Unassigned</span></button>
      ${sections
        .map(
          (s) =>
            `<button type="button" class="ctx-item ${bot.section === s.id ? "on" : ""}" data-act="ctx-move" data-id="${bot.id}" data-sec="${escapeHtml(s.id)}">${ctxIcon("folder")}<span>${escapeHtml(s.name)}</span></button>`,
        )
        .join("")}
    </div>`;
  }
  let namePrompt = "";
  if (ctx.naming) {
    namePrompt = `<div class="ctx-prompt" style="top:${top}px;left:${left + 228}px">
      <input id="ctx-sec-name" class="field" placeholder="Section name" />
      <button type="button" class="pill primary" data-act="ctx-create-section" data-id="${bot.id}">Create</button>
    </div>`;
  }
  host.innerHTML = `
    <div class="ctx-menu" style="top:${top}px;left:${left}px">
      ${item("ctx-pin", "pin", bot.pinned ? "Unpin" : "Pin")}
      <button type="button" class="ctx-item has-sub" data-act="ctx-move-open" data-id="${bot.id}">${ctxIcon("folder")}<span>Move to</span><span class="ctx-caret">›</span></button>
      ${item("ctx-unread", "unread", bot.unread ? "Mark as Read" : "Mark as Unread")}
      <div class="ctx-sep"></div>
      ${item("ctx-edit", "edit", "Edit Profile")}
      ${item("ctx-dup", "dup", "Duplicate")}
      <div class="ctx-sep"></div>
      ${item("ctx-copy", "copy", "Copy conversation ID")}
      ${item("ctx-hide", "hide", bot.hidden ? "Show in sidebar" : "Hide from sidebar")}
      <div class="ctx-sep"></div>
      ${item("ctx-del", "del", "Delete", "ctx-danger")}
    </div>
    ${move}
    ${namePrompt}`;
  if (ctx.naming) setTimeout(() => $("#ctx-sec-name")?.focus(), 20);
}

function pickerHtml() {
  return `<div class="picker">
    <input id="pickq" placeholder="Search or create Bots" />
    <div class="pick" data-act="create"><span class="avatar" style="background:#f3f4f6;color:#111">+</span> Create new Bot <span class="kbd">⌘1</span></div>
    ${state.bots
      .map(
        (b) =>
          `<div class="pick ${b.id === state.selected ? "on" : ""}">
            <button class="pick-main" data-act="select" data-id="${b.id}">
              <span class="avatar sm" data-avatar="${b.id}" data-avatar-slot="pick" data-avatar-size="40" data-avatar-framing="body"></span>
              ${escapeHtml(b.name)}
            </button>
            <button class="pill" data-act="edit-bot" data-id="${b.id}">Edit</button>
            ${b.hidden ? `<button class="pill" data-act="ctx-hide" data-id="${b.id}">Show</button>` : ""}
          </div>`
      )
      .join("")}
  </div>`;
}

function paintLivePane(bot) {
  const pane = $("#live-pane");
  if (!pane) return;
  if (
    !$("#pane-head") ||
    !$("#computer-stack") ||
    !$("#bot-editor") ||
    document.querySelector('[data-act="desk-full"], [data-act="reconnect"], [data-act="resume-vm"], .desk-tools')
  ) {
    liveFrameKey = null;
    pane.innerHTML = `
    <div class="pane-head" id="pane-head"></div>
    <div id="computer-stack">
      <div class="screen-wrap" id="screen-wrap"></div>
      <div class="desk-actions">
        <button class="pill" data-act="refresh-stream" type="button">Refresh stream</button>
        <button class="pill" data-act="reboot-vm" type="button">Reboot</button>
        <button class="pill" data-act="open-desk" type="button">${iconExpand()} Open</button>
      </div>
      <div class="screen-label" id="screen-label"></div>
      <div class="section-h">Routines <button class="iconbtn add-routine" data-act="add-routine" type="button" title="Add routine">+</button></div>
      <div id="routine-list"></div>
      <p class="error" id="vm-error"></p>
    </div>
    <div id="bot-editor" class="bot-editor" hidden></div>`;
  }
  {
    let row = $(".desk-actions");
    if (!row && $("#screen-wrap")) {
      row = document.createElement("div");
      row.className = "desk-actions";
      $("#screen-wrap").after(row);
    }
    if (row) {
      row.innerHTML = `<button class="pill" data-act="refresh-stream" type="button">Refresh stream</button>
        <button class="pill" data-act="reboot-vm" type="button">Reboot</button>
        <button class="pill" data-act="open-desk" type="button">${iconExpand()} Open</button>`;
    }
  }
  paintPaneHead(bot);
  const computer = $("#computer-stack");
  const editor = $("#bot-editor");
  pane.hidden = !bot || (!state.showComputer && !state.botEdit && state.deskSize !== "full");
  if (computer) computer.hidden = !state.showComputer || state.botEdit;
  if (editor) {
    editor.hidden = !state.botEdit;
    if (state.botEdit && bot) paintBotEditor(bot);
  }
  const label = $("#screen-label");
  if (label && bot) {
    label.textContent =
      bot.vm?.status === "starting" && bot.vm.hint ? bot.vm.hint : `${bot.name}'s screen`;
  }
  const err = $("#vm-error");
  if (err) {
    const hard = bot?.vm?.status === "error" && bot.vm.error && !isTransientVmError(bot.vm.error);
    err.textContent = hard ? bot.vm.error : "";
  }
  paintRoutineList(bot);
  if (bot) attachLiveFrame(bot);
}

function paintPaneHead(bot) {
  const head = $("#pane-head");
  if (!head || !bot) return;
  const mode = state.deskSize === "full" ? "full" : state.botEdit ? "settings" : "desk";
  if (head.dataset.mode === mode) return;
  head.dataset.mode = mode;
  head.classList.toggle("is-settings", mode === "settings");
  if (mode === "settings") {
    head.hidden = false;
    head.innerHTML = `
      <button class="iconbtn" data-act="bot-settings" title="Back">${iconBack()}</button>
      <h2>Settings</h2>
      <span class="grow"></span>`;
  } else {
    head.hidden = true;
    head.innerHTML = "";
  }
}

function paintBotEditor(bot) {
  const host = $("#bot-editor");
  if (!host) return;
  const active = document.activeElement;
  if (host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && host.dataset.bot === bot.id) {
    return;
  }
  host.dataset.bot = bot.id;
  const colors = AVATAR_COLORS;
  const color = bot.color || AVATAR_COLORS[0];
  const avatar = defaultAvatar(bot.avatar);
  host.innerHTML = `
    <div class="avatar-studio">
      <div class="avatar-preview" data-avatar="${bot.id}" data-avatar-slot="editor" data-avatar-size="168" data-avatar-framing="body" data-preview="1"></div>
    </div>
    <label class="muted">Name</label>
    <input class="field" id="bn" value="${escapeHtml(bot.name || "")}" placeholder="Bot name" />
    <label class="muted">Title</label>
    <input class="field" id="bt" value="${escapeHtml(bot.title || "")}" placeholder="Describe what your Bot does" />
    <label class="muted">Description</label>
    <textarea class="field" id="bd" placeholder="What this Bot is for">${escapeHtml(bot.description || "")}</textarea>
    <div class="card row notify-card">
      <div>
        <div class="lbl">Notifications</div>
        <div class="sub">Get notified when this Bot finishes or needs input</div>
      </div>
      <button class="toggle ${bot.notificationsEnabled ? "on" : ""}" data-act="bot-notify"><i></i></button>
    </div>
    <label class="muted">Body</label>
    <div class="chips chips-scroll" id="body-chips">
      ${bodyList()
        .map(
          (b) =>
            `<button type="button" class="chip ${b.id === avatar.body ? "on" : ""}" data-act="avatar-body" data-id="${b.id}">${escapeHtml(b.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Face</label>
    <div class="chips chips-scroll" id="face-chips">
      ${faceList()
        .map(
          (f) =>
            `<button type="button" class="chip ${f.id === avatar.expression ? "on" : ""}" data-act="avatar-face" data-id="${f.id}">${escapeHtml(f.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Motion</label>
    <div class="chips chips-scroll" id="anim-chips">
      ${animList()
        .map(
          (a) =>
            `<button type="button" class="chip ${a.id === avatar.animation ? "on" : ""}" data-act="avatar-anim" data-id="${a.id}">${escapeHtml(a.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Instructions</label>
    <textarea class="field" id="bi" placeholder="Standing rules this Bot always follows">${escapeHtml(bot.instructions || "")}</textarea>
    <label class="muted">Harness</label>
    <select class="field" id="bh">
      ${harnessProviderOptions(bot.harness?.provider || "default")}
    </select>
    <label class="muted">Model</label>
    ${modelPickerHtml(bot.harness?.provider || "default", bot.harness?.model || "", { id: "bm" })}
    <label class="muted">Color</label>
    <div class="muted" style="margin:0 0 6px">Light colors use dark eyes and mouth.</div>
    <div class="swatches">
      ${colors
        .map(
          (c) =>
            `<button type="button" class="swatch ${c.toLowerCase() === color.toLowerCase() ? "on" : ""}" data-act="bot-color" data-color="${c}" style="background:${c}"></button>`
        )
        .join("")}
      <label class="swatch swatch-custom ${colors.some((c) => c.toLowerCase() === color.toLowerCase()) ? "" : "on"}" title="Custom color">
        <input type="color" id="bot-color-pick" value="${escapeHtml(color)}" />
      </label>
    </div>
    <button class="pill" style="margin-top:16px" data-act="advanced">Advanced</button>
    <button class="pill" style="margin-top:16px" data-act="save-bot">Save</button>
    <button class="danger" style="margin-top:10px" data-act="delete-bot" data-id="${bot.id}">${
      state.confirmDeleteId === bot.id ? "Click again to delete" : "Delete Bot"
    }</button>`;
}

function paintRoutineList(bot) {
  const rl = $("#routine-list");
  if (!rl || !bot) return;
  const rows = bot.routines || [];
  if (!rows.length) {
    rl.innerHTML = `<div class="routine-row"><span class="routine-clock">${iconClock()}</span><div><b>No routines yet</b><div class="muted">Ask in chat, or press + to add one</div></div></div>`;
    return;
  }
  rl.innerHTML = rows
    .map((r) => {
      const on = r.enabled !== false;
      return `<div class="routine-card ${on ? "" : "off"}">
        <div class="routine-top">
          <span class="routine-clock">${iconClock()}</span>
          <div class="routine-copy">
            <b>${escapeHtml(r.name || "Routine")}</b>
            <div class="muted">${escapeHtml(routineCadence(r))}${on ? "" : ", paused"}${r.lastRunAt ? ` · last ${fmtWhen(r.lastRunAt, r.schedule?.type === "daily" ? state.timezone : "")}` : ""}</div>
          </div>
        </div>
        <p class="routine-body">${escapeHtml(previewRoutine(r.instruction))}</p>
        <div class="routine-actions">
          <button class="pill" data-act="toggle-routine" data-id="${r.id}">${on ? "Pause" : "Resume"}</button>
          <button class="pill" data-act="edit-routine" data-id="${r.id}">Edit</button>
          <button class="pill danger-pill" data-act="delete-routine" data-id="${r.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

function routineClock(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) return "";
  const twelveHour = h % 12 || 12;
  return `${twelveHour}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function routineCadence(r) {
  const schedule = r?.schedule;
  if (schedule?.type === "daily") {
    const clock = routineClock(schedule.hour, schedule.minute);
    if (clock) return `Every day at ${clock} (${state.timezone || "local time"})`;
  }
  const mins = Math.max(1, Math.round((r?.intervalMs || 0) / 60000));
  return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
}

function morningScheduleFromInstruction(text) {
  const t = String(text || "");
  const match = t.match(/\b(?:every|each)\s+morning\b/i);
  if (!match) return null;
  const suffix = t.slice((match.index || 0) + match[0].length);
  if (
    /[?]|^\s*(?:at|around|by|before|after|until)\b|^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|ish)?\b|^\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+o['’]?clock)?\b|^\s*half\s+past\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b|\b(?:in|until|before|after)\s+(?:the\s+)?(?:am|pm|noon|midnight)\b|\b(?:noon|midnight)\b/i.test(
      suffix,
    )
  ) return null;
  return { type: "daily", hour: 9, minute: 0 };
}

function fmtWhen(ts, timeZone = "") {
  const n = Number(ts);
  if (!n) return "—";
  const d = new Date(n);
  const now = Date.now();
  const ago = Math.max(0, now - n);
  if (ago < 60_000) return "just now";
  if (ago < 3600_000) return `${Math.round(ago / 60_000)} min ago`;
  const zone = timeZone || undefined;
  if (ago < 86400_000) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: zone });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone });
}

function previewRoutine(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const first = t.split(/\n/).find((l) => l.trim()) || t;
  if (t.length <= 180) return first;
  return `${first.slice(0, 160).trim()}…`;
}

function paintModal() {
  const host = $("#modal-host");
  if (!host) return;
  const bot = state.bots.find((b) => b.id === state.selected);
  const key = `${state.modal || ""}|${state.section}|${state.editingRoutineId || ""}|${state.selected || ""}|${state.vaultGroup || ""}|${state.vaultEditId || ""}|${state.computerId || ""}|${state.computerAttach ? "1" : "0"}|${state.deleteBotId || ""}|${state.computerView}|${state.computerSort}`;
  if (!state.modal) {
    host.innerHTML = "";
    delete host.dataset.key;
    return;
  }
  const active = document.activeElement;
  const typing = host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || "");
  // Never rebuild a form modal in place — SSE/health render() would wipe
  // the fields and steal the Create click onto the overlay.
  const keepForm = typing || state.modal === "routine" || state.modal === "create" || state.modal === "vault";
  if (host.dataset.key === key && host.innerHTML && keepForm) return;
  host.dataset.key = key;
  if (state.modal === "create") host.innerHTML = createBotHtml();
  else if (state.modal === "vault") host.innerHTML = vaultHtml();
  else if (state.modal === "computers") host.innerHTML = computersHtml();
  else if (state.modal === "delete-bot") host.innerHTML = deleteBotHtml();
  else if (state.modal === "settings") host.innerHTML = settingsHtml();
  else if (state.modal === "advanced" && bot) host.innerHTML = advancedHtml(bot);
  else if (state.modal === "routine" && bot) {
    host.innerHTML = routineEditorHtml(bot);
  } else host.innerHTML = "";
}

function advancedHtml(bot) {
  const h = resolvedHarness(bot);
  const s = bot.storage || {};
  const local = bot.harness || {};
  const base =
    local.provider === "lmstudio"
      ? "http://127.0.0.1:1234/v1"
      : local.provider === "ollama"
        ? "http://127.0.0.1:11434/v1"
        : h.provider === "claude" || h.provider === "codex" || h.provider === "hermes"
          ? "host CLI"
          : state.settings?.harness?.baseUrl || "https://api.x.ai/v1";
  const msgs = bot.messages || [];
  const visible = msgs.filter((m) => !m.hidden && m.role !== "tool");
  const routineN = (bot.routines || []).length;
  const row = (label, value) =>
    `<div class="adv-row"><div class="muted">${escapeHtml(label)}</div><code class="adv-val" title="${escapeHtml(value)}">${escapeHtml(value || "—")}</code></div>`;
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(560px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Advanced</h2>
        <p class="muted" style="margin-top:-10px">This conversation’s storage and session.</p>
        <div class="adv-card">
          ${row("Session ID", s.sessionId || bot.id)}
          ${
            h.provider === "grok-build"
              ? row("Grok Build session", bot.grokSessionId || bot.id)
              : ""
          }
          ${row("Bot", bot.name)}
          ${row("Model", h.model || "—")}
          ${row("Harness", h.provider || "—")}
          ${row("API base", base)}
          ${row("Routines", routineN ? String(routineN) : "none")}
          ${row("History file", s.conversationFile || "")}
          ${row("Bots file", s.botsFile || "")}
          ${row("Screenshot file", s.screensFile || "")}
          ${row("Data folder", s.dataDir || "")}
          ${row("Messages", String(visible.length))}
          ${row("Created", bot.createdAt ? new Date(bot.createdAt).toLocaleString() : "—")}
          ${row("Updated", bot.updatedAt ? new Date(bot.updatedAt).toLocaleString() : "—")}
          ${row("Computer", bot.vm?.status || "idle")}
          ${row("Container", bot.vm?.container || "—")}
          ${row("Stream port", bot.vm?.novncPort ? String(bot.vm.novncPort) : "—")}
          ${row("VM log", (s.dataDir ? `${s.dataDir}/traces/${bot.id}.jsonl` : `data/traces/${bot.id}.jsonl`))}
        </div>
        <p class="muted">Outside tunnel = screenshot/click. Inside tunnel = shell in the VM. Host Mac is never a target.</p>
      </div>
    </div>
  </div>`;
}

function routineEditorHtml(bot) {
  const r = (bot.routines || []).find((x) => x.id === state.editingRoutineId);
  const isNew = !r;
  const isCalendar = r?.schedule?.type === "daily";
  const mins = r ? Math.max(1, Math.round((r.intervalMs || 0) / 60000)) : 15;
  const on = r?.enabled !== false;
  const runs = Array.isArray(r?.runs) ? [...r.runs].reverse().slice(0, 12) : [];
  return `<div class="overlay">
    <div class="modal routine-modal" data-modal="1">
      <div class="sbody routine-editor">
        <button class="close" data-act="close-modal">×</button>
        <div class="routine-editor-head">
          <h2>${isNew ? "New routine" : "Main routine"}</h2>
          ${
            isNew
              ? ""
              : `<button type="button" class="toggle ${on ? "on" : ""}" id="re-tog" data-act="routine-enabled" title="Enabled"><i></i></button>`
          }
        </div>
        <div class="routine-grid">
          <label class="routine-field">
            <span class="muted">Name</span>
            <input class="field" id="rn" value="${escapeHtml(r?.name || "")}" placeholder="Main routine" />
          </label>
          <label class="routine-field">
            <span class="muted">${isCalendar ? "Schedule" : "Every"}</span>
            ${
              isCalendar
                ? `<div class="routine-schedule-display">${escapeHtml(routineCadence(r))}</div>`
                : `<div class="routine-mins">
              <input class="field" id="rm" type="number" min="1" value="${mins}" />
              <span class="muted">minutes</span>
            </div>`
            }
          </label>
        </div>
        <label class="routine-field routine-brief">
          <span class="muted">What it should do</span>
          <textarea class="field" id="ri" placeholder="Standing brief: who you are, what to check, how to reply, when to stop.">${escapeHtml(r?.instruction || "")}</textarea>
        </label>
        ${
          isNew
            ? ""
            : `<div class="routine-history">
          <div class="muted">Trigger history</div>
          ${
            runs.length
               ? `<ul>${runs.map((x) => `<li>${escapeHtml(fmtWhen(x.ts, r?.schedule?.type === "daily" ? state.timezone : ""))}</li>`).join("")}</ul>`
              : `<p class="muted">No runs logged yet. They appear here each time this routine fires.</p>`
          }
        </div>`
        }
        <div class="routine-editor-foot">
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
          <button type="button" class="pill primary" data-act="save-routine">${isNew ? "Create" : "Save"}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function botSettingsHtml(bot) {
  return `<aside class="pane" style="background:#fff">
    <div class="section-h"><button class="iconbtn" data-act="bot-settings">‹</button> Settings</div>
    <div class="botset">
      <div class="avatar-preview sm" data-avatar="${bot.id}" data-avatar-slot="legacy-settings" data-avatar-size="128" data-avatar-framing="body" data-preview="1"></div>
      <label class="muted">Name</label>
      <input class="field" id="bn" value="${escapeHtml(bot.name)}" />
      <label class="muted">Title</label>
      <input class="field" id="bt" placeholder="Describe what your Bot does" value="${escapeHtml(bot.title || "")}" />
      <label class="muted">Description</label>
      <textarea class="field" id="bd">${escapeHtml(bot.description || "")}</textarea>
      <label class="muted">Instructions</label>
      <textarea class="field" id="bi" placeholder="Standing instructions for this Bot">${escapeHtml(bot.instructions || "")}</textarea>
      <button class="pill" data-act="save-bot">Save</button>
    </div>
  </aside>`;
}

function harnessProviderOptions(selected) {
  return [
    ["default", "App default"],
    ["grok-build", "Grok Build"],
    ["hermes", "Hermes"],
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["ollama", "Ollama"],
    ["lmstudio", "LM Studio"],
    ["spacexai", "SpaceXAI"],
  ]
    .map(([id, label]) => `<option value="${id}" ${selected === id ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function modelPickerHtml(provider, selected, { id = "cm" } = {}) {
  const models = localModels(provider);
  const local = provider === "ollama" || provider === "lmstudio";
  const grok = provider === "grok-build" || provider === "spacexai";
  const detected = state.localHarness?.[provider];
  if ((local || grok) && models.length) {
    const value = models.includes(selected) ? selected : grok ? "grok-4.6" : models[0];
    const label = provider === "lmstudio" ? "LM Studio" : provider === "ollama" ? "Ollama" : "Grok Build";
    return `<select class="field" id="${id}">${models
      .map((m) => `<option value="${escapeHtml(m)}" ${value === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
      .join("")}</select>
      <div class="muted">${escapeHtml(label)} · ${models.length} available</div>`;
  }
  if (local) {
    return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="${
      detected?.ok ? "no chat models detected" : "start the app to list models"
    }" />
      <div class="muted">${detected?.ok ? "Running, but no chat models yet." : "Not detected. Start the app, then Refresh."}</div>
      <button type="button" class="pill" data-act="refresh-local-harness">Refresh models</button>`;
  }
  if (provider === "claude" || provider === "codex" || provider === "hermes") {
    return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="${
      provider === "hermes" ? "Hermes default" : "default"
    }" />`;
  }
  if (provider === "default") {
    const def = state.settings?.harness?.model || "app default";
    return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="${escapeHtml(def)}" />
      <div class="muted">Uses the harness in Settings unless you set one here.</div>`;
  }
  return `<input class="field" id="${id}" value="${escapeHtml(selected || "")}" placeholder="grok-4.6" />`;
}

function snapshotCreateForm() {
  const n = $("#cn")?.value;
  const d = $("#cd")?.value;
  const m = $("#cm")?.value;
  const h = $("#ch")?.value;
  if (n != null) state.createName = n;
  if (d != null) state.createDesc = d;
  if (m != null) state.createModel = m;
  if (h != null) state.createHarness = h;
}

function resetCreateForm() {
  state.createFace = "neutral";
  state.createHarness = "default";
  state.createModel = "";
  state.createName = "";
  state.createDesc = "";
}

function rebuildCreateModal() {
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  paintModal();
  refreshAvatars();
}

function computerStateLabel(st, row) {
  if (row?.stuck || row?.stale) return st === "running" ? "Running?" : "Can't see";
  if (st === "running") return "Running";
  if (st === "paused") return "Paused";
  if (st === "exited" || st === "stopped") return "Stopped";
  if (st === "missing") return "Missing";
  if (st === "unknown") return "Can't see";
  return st || "Unknown";
}

function harnessLabel(id) {
  return (
    { "grok-build": "Grok Build", hermes: "Hermes", claude: "Claude", codex: "Codex", ollama: "Ollama", lmstudio: "LM Studio", spacexai: "SpaceXAI" }[id] ||
    id ||
    ""
  );
}

function sortedComputers() {
  const rows = [...(state.computers || [])];
  const rank = { running: 0, paused: 1, starting: 2, exited: 3, stopped: 3, missing: 4 };
  const key = state.computerSort || "name";
  rows.sort((a, b) => {
    if (key === "mem") {
      const am = state.computerStats[a.container]?.memBytes || 0;
      const bm = state.computerStats[b.container]?.memBytes || 0;
      return bm - am;
    }
    if (key === "status") return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name);
    if (key === "bot") return String(a.attachedBotName || "zzz").localeCompare(String(b.attachedBotName || "zzz"));
    if (key === "harness") return String(a.harness?.label || "zzz").localeCompare(String(b.harness?.label || "zzz"));
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return rows;
}

function memBarHtml(container, compact = false) {
  const st = state.computerStats[container];
  const pct = Math.max(0, Math.min(100, Number(st?.memPct) || 0));
  const label = st?.mem ? st.mem.replace(/iB$/i, "B") : "—";
  const tone = pct >= 85 ? "hot" : pct >= 60 ? "warm" : "ok";
  return `<div class="cmem ${compact ? "sm" : ""}" data-cmem="${escapeHtml(container)}">
    <div class="cmem-top"><span>RAM</span><span data-cmem-label>${escapeHtml(label)}</span></div>
    <div class="cmem-track"><i class="cmem-fill ${tone}" data-cmem-fill style="width:${pct}%"></i></div>
  </div>`;
}

function harnessPill(h) {
  if (!h?.provider) return `<span class="hpill muted">No harness</span>`;
  return `<span class="hpill hpill-${escapeHtml(h.provider)}" title="${escapeHtml(h.model || "")}">${escapeHtml(
    h.label || harnessLabel(h.provider),
  )}</span>`;
}

function computerPreviewHtml(c) {
  const src = c.previewUrl || (c.previewBotId || c.attachedBotId || c.lastBotId ? `/api/bots/${c.previewBotId || c.attachedBotId || c.lastBotId}/screen` : "");
  const tick = state.previewTick || 0;
  return `<div class="cprev">
    ${src ? `<img alt="" src="${src}${src.includes("?") ? "&" : "?"}t=${tick}" onerror="this.style.display='none'" />` : ""}
    <div class="cprev-empty">${
      c.stuck || c.stale ? "Can't reach Docker" : c.status === "running" || c.status === "starting" ? "No preview yet" : "Desk is off"
    }</div>
  </div>`;
}

function computerBotLink(c) {
  if (!c.attachedBotId) return `<span class="crow-meta">Unattached</span>`;
  return `<button type="button" class="clink" data-act="open-computer-bot" data-id="${escapeHtml(c.attachedBotId)}" title="Open ${escapeHtml(c.attachedBotName || "Bot")}">${escapeHtml(
    c.attachedBotName || "Bot",
  )}</button>`;
}

function computerActions(row) {
  return `
    ${
      row.status === "paused"
        ? `<button type="button" class="pill primary" data-act="computer-act" data-do="resume" data-id="${row.id}">Resume</button>`
        : row.status === "running"
          ? `<button type="button" class="pill" data-act="computer-act" data-do="pause" data-id="${row.id}">Pause</button>`
          : `<button type="button" class="pill primary" data-act="computer-act" data-do="start" data-id="${row.id}">Start</button>`
    }
    ${
      row.status === "running" || row.status === "paused"
        ? `<button type="button" class="pill" data-act="computer-act" data-do="reboot" data-id="${row.id}">Reboot</button>
        <button type="button" class="pill" data-act="computer-act" data-do="stop" data-id="${row.id}">Stop</button>`
        : ""
    }
    ${
      row.attachedBotId
        ? `<button type="button" class="pill" data-act="computer-act" data-do="detach" data-id="${row.id}">Detach</button>`
        : `<button type="button" class="pill" data-act="computer-attach-open" data-id="${row.id}">Attach to…</button>`
    }
    <button type="button" class="danger" data-act="computer-act" data-do="destroy" data-id="${row.id}">Destroy</button>`;
}

function computersHtml() {
  const rows = sortedComputers();
  const id = state.computerId || rows[0]?.id || "";
  const row = rows.find((c) => c.id === id) || rows[0];
  const view = state.computerView === "list" ? "list" : "grid";
  const freeBots = state.bots.filter((b) => !b.hidden && !b.vm?.computerId);
  const attachPicker =
    row && state.computerAttach
      ? `<div class="cattach">${
          freeBots.length
            ? freeBots
                .map(
                  (b) =>
                    `<button type="button" class="pill" data-act="computer-attach" data-id="${row.id}" data-bot="${b.id}">${escapeHtml(b.name)}</button>`,
                )
                .join("")
            : `<span class="muted">Every Bot already has a computer.</span>`
        }</div>`
      : "";
  const cards = rows
    .map((c) => {
      const on = c.id === row?.id ? "on" : "";
      const st = c.status === "running" ? "ok" : c.status === "paused" ? "warn" : "bad";
      if (view === "list") {
        return `<div class="crow ${on}" data-act="computer-select" data-id="${c.id}">
          <div class="crow-main">
            <div class="crow-title">${escapeHtml(c.name)}</div>
            ${computerBotLink(c)}
          </div>
          <div class="crow-pills">${harnessPill(c.harness)}<span class="hbadge ${st}">${escapeHtml(computerStateLabel(c.status, c))}</span></div>
          ${memBarHtml(c.container, true)}
        </div>`;
      }
      return `<div class="ccard ${on}" data-act="computer-select" data-id="${c.id}">
        ${computerPreviewHtml(c)}
        <div class="ccard-body">
          <div class="crow-title">${escapeHtml(c.name)}</div>
          ${computerBotLink(c)}
          <div class="crow-pills">${harnessPill(c.harness)}<span class="hbadge ${st}">${escapeHtml(computerStateLabel(c.status, c))}</span></div>
          ${memBarHtml(c.container, true)}
        </div>
      </div>`;
    })
    .join("");
  const detail = row
    ? `<div class="cdetail">
        <input class="field" data-computer-name="${row.id}" value="${escapeHtml(row.name)}" />
        <span class="muted mono">${escapeHtml(row.container || "")}</span>
        ${row.attachedBotId ? computerBotLink(row) : ""}
        <div class="cdetail-acts">${computerActions(row)}</div>
        ${attachPicker}
      </div>`
    : `<p class="muted">No computers yet. Start a Bot and it gets a desk.</p>`;
  return `<div class="overlay">
    <div class="modal computers-modal" data-modal="1">
      <div class="sbody" style="width:100%;display:flex;flex-direction:column;min-height:0">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        <div class="ctool">
          <div>
            <h2 style="margin:0">Computers</h2>
            <p class="muted" style="margin:4px 0 0">Linux desks. Quit pauses them. They wake when you open Sub8.</p>
          </div>
          <div class="ctool-right">
            ${
              dockerMissing()
                ? `<button type="button" class="pill primary" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
                    state.dockerBusy ? "Recovering…" : "Recover Docker"
                  }</button>`
                : ""
            }
            <select class="field csort" data-computer-sort>
              <option value="name" ${state.computerSort === "name" ? "selected" : ""}>Name</option>
              <option value="mem" ${state.computerSort === "mem" ? "selected" : ""}>Memory</option>
              <option value="status" ${state.computerSort === "status" ? "selected" : ""}>State</option>
              <option value="bot" ${state.computerSort === "bot" ? "selected" : ""}>Bot</option>
              <option value="harness" ${state.computerSort === "harness" ? "selected" : ""}>Harness</option>
            </select>
            <div class="seg">
              <button type="button" class="seg-btn ${view === "grid" ? "on" : ""}" data-act="computer-view" data-id="grid">Grid</button>
              <button type="button" class="seg-btn ${view === "list" ? "on" : ""}" data-act="computer-view" data-id="list">List</button>
            </div>
          </div>
        </div>
        ${dockerMissing() ? dockerMissingHtml() : ""}
        <div class="cboard ${view}">${cards || `<div class="muted" style="padding:20px">None yet.</div>`}</div>
        ${detail}
      </div>
    </div>
  </div>`;
}

function deleteBotHtml() {
  const bot = state.bots.find((b) => b.id === state.deleteBotId);
  if (!bot) return "";
  const desk = (state.computers || []).find((c) => c.id === bot.vm?.computerId || c.attachedBotId === bot.id);
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(480px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Delete ${escapeHtml(bot.name)}?</h2>
        <p class="muted">The Bot leaves the rail. Choose what happens to its Linux computer${
          desk ? ` (${escapeHtml(desk.name)})` : ""
        }.</p>
        <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:14px">
          <button type="button" class="pill primary" data-act="delete-bot-go" data-keep="1">Keep the computer</button>
          <div class="sub">Desk stays under Computers, unattached. Files and logins stay. Attach it to another Bot later.</div>
          <button type="button" class="danger" data-act="delete-bot-go" data-keep="0">Delete the computer too</button>
          <div class="sub">The desk and its volume are destroyed. This cannot be undone.</div>
          <button type="button" class="pill" data-act="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

function createBotHtml() {
  const provider = state.createHarness || "default";
  return `<div class="overlay">
    <div class="modal create-modal" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Create new Bot</h2>
        <div class="botset">
          <div class="create-top">
            <div class="avatar-preview sm" data-avatar="create" data-avatar-slot="create" data-avatar-size="128" data-avatar-framing="body" data-preview="1"></div>
            <div class="create-col">
              <label class="muted">Name</label>
              <input class="field" id="cn" placeholder="New Bot" value="${escapeHtml(state.createName || "")}" autofocus />
              <label class="muted">What this Bot is for</label>
              <textarea class="field" id="cd" placeholder="Describe the job">${escapeHtml(state.createDesc || "")}</textarea>
            </div>
            <div class="create-col">
              <label class="muted">Harness</label>
              <select class="field" id="ch">${harnessProviderOptions(provider)}</select>
              <label class="muted">Model</label>
              ${modelPickerHtml(provider, state.createModel || "")}
            </div>
          </div>
          <label class="muted">Face</label>
          <div class="chips chips-scroll">
            ${faceList()
              .map(
                (f) =>
                  `<button type="button" class="chip ${f.id === state.createFace ? "on" : ""}" data-act="create-face" data-id="${f.id}">${escapeHtml(f.label)}</button>`
              )
              .join("")}
          </div>
        </div>
        <button type="button" class="pill primary" data-act="confirm-create" id="confirm-create">Create Bot</button>
      </div>
    </div>
  </div>`;
}

function vaultAccountsInView() {
  const all = state.vault.accounts || [];
  if (state.vaultGroup === "all") return all;
  if (state.vaultGroup === "none") return all.filter((a) => !a.groupId);
  return all.filter((a) => a.groupId === state.vaultGroup);
}

function vaultHtml() {
  const groups = state.vault.groups || [];
  const accs = vaultAccountsInView();
  const edit =
    state.vaultEditId === "new"
      ? { id: "new", label: "", site: "", username: "", notes: "", groupId: state.vaultGroup === "none" || state.vaultGroup === "all" ? "" : state.vaultGroup }
      : (state.vault.accounts || []).find((a) => a.id === state.vaultEditId);
  const grantSet = (botId) => new Set(state.vault.grants?.[botId] || []);
  const navBtn = (id, label) =>
    `<button type="button" class="${state.vaultGroup === id ? "active" : ""}" data-act="vault-group" data-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  return `<div class="overlay">
    <div class="modal vault-modal" data-modal="1">
      <nav class="snav">
        ${navBtn("all", "All logins")}
        ${navBtn("none", "Ungrouped")}
        ${groups.map((g) => navBtn(g.id, g.name)).join("")}
        <button type="button" data-act="vault-add-group">+ Group</button>
      </nav>
      <div class="sbody">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        <h2>Password vault</h2>
        <p class="muted" style="margin-top:-8px">Encrypted on this machine. Bots can paste into a field but never see the secret in chat.</p>
        <div class="vault-toolbar">
          <button type="button" class="pill primary" data-act="vault-add-account">New login</button>
        </div>
        <div class="vault-list">
          ${
            accs.length
              ? accs
                  .map(
                    (a) =>
                      `<button type="button" class="vault-row ${a.id === state.vaultEditId ? "on" : ""}" data-act="vault-edit" data-id="${a.id}">
                        <strong>${escapeHtml(a.label)}</strong>
                        <span class="muted">${escapeHtml(a.username || "—")} · ${escapeHtml(a.site || "no site")}</span>
                      </button>`,
                  )
                  .join("")
              : `<p class="muted">No logins in this group yet.</p>`
          }
        </div>
        ${
          edit
            ? `<div class="vault-editor">
          <label class="muted">Name</label>
          <input class="field" id="v-label" value="${escapeHtml(edit.label || "")}" placeholder="Gmail work" />
          <label class="muted">Site</label>
          <input class="field" id="v-site" value="${escapeHtml(edit.site || "")}" placeholder="https://mail.google.com" />
          <label class="muted">Username</label>
          <input class="field" id="v-user" value="${escapeHtml(edit.username || "")}" autocomplete="off" />
          <label class="muted">Password</label>
          <div class="vault-pass">
            <input class="field" id="v-pass" type="${state.vaultReveal ? "text" : "password"}" value="${edit.id === "new" ? "" : "••••"}" autocomplete="new-password" />
            <button type="button" class="pill" data-act="vault-reveal">${state.vaultReveal ? "Hide" : "Show"}</button>
          </div>
          <label class="muted">Notes</label>
          <textarea class="field" id="v-notes" placeholder="Optional">${escapeHtml(edit.notes || "")}</textarea>
          <label class="muted">Group</label>
          <select class="field" id="v-group">
            <option value="">Ungrouped</option>
            ${groups.map((g) => `<option value="${g.id}" ${g.id === (edit.groupId || "") ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}
          </select>
          <label class="muted">Bots that may use this login</label>
          <div class="vault-grants">
            ${(state.bots || [])
              .map((b) => {
                const on = edit.id !== "new" && grantSet(b.id).has(edit.id);
                return `<label class="vault-grant"><input type="checkbox" data-vault-bot="${b.id}" ${on ? "checked" : ""}/> ${escapeHtml(b.name)}</label>`;
              })
              .join("") || `<span class="muted">Create a Bot first.</span>`}
          </div>
          <div class="routine-editor-foot">
            ${edit.id !== "new" ? `<button type="button" class="danger" data-act="vault-delete" data-id="${edit.id}">Delete</button>` : ""}
            <span class="grow"></span>
            <button type="button" class="pill" data-act="vault-cancel">Cancel</button>
            <button type="button" class="pill primary" data-act="vault-save">Save</button>
          </div>
        </div>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

function seg(key, value, options) {
  return `<div class="seg" role="tablist">${options
    .map(
      ([id, label]) =>
        `<button type="button" class="seg-btn ${value === id ? "on" : ""}" data-act="set-pref" data-set="${key}" data-id="${id}">${escapeHtml(label)}</button>`,
    )
    .join("")}</div>`;
}

function grokModels() {
  const live = state.localHarness?.grok?.models;
  if (Array.isArray(live) && live.length) return live;
  return ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"];
}

function localModels(provider) {
  if (provider === "grok-build" || provider === "spacexai") return grokModels();
  if (provider === "hermes") {
    const lm = state.localHarness?.lmstudio?.models || [];
    const current = harnessInfo("hermes")?.model || "";
    const extra = ["qwen3.8-27b", "qwen3.6-27b-mlx"];
    return [...new Set([current, ...lm, ...extra].filter(Boolean))];
  }
  return state.localHarness?.[provider]?.models || [];
}

function pickModelForProvider(provider, current = "") {
  const models = localModels(provider);
  if (provider === "grok-build" || provider === "spacexai") {
    return models.includes(current) ? current : "grok-4.6";
  }
  if (provider === "ollama" || provider === "lmstudio") {
    if (models.length) return models.includes(current) ? current : models[0];
    return "";
  }
  if (provider === "claude" || provider === "codex" || provider === "hermes") return "";
  return current || "";
}

function harnessCatalog() {
  return (
    state.harnessStatus?.catalog || [
      { id: "grok-build", label: "Grok Build" },
      { id: "hermes", label: "Hermes" },
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "ollama", label: "Ollama" },
      { id: "lmstudio", label: "LM Studio" },
      { id: "spacexai", label: "SpaceXAI" },
    ]
  );
}

function harnessInfo(id) {
  return state.harnessStatus?.harnesses?.[id] || null;
}

function statusTone(info) {
  if (!info) return "unknown";
  if (info.ready) return "ok";
  if (info.installed && !info.signedIn) return "warn";
  if (!info.installed) return "bad";
  return "warn";
}

function statusLabel(info) {
  if (!info) return "Checking…";
  if (info.ready && info.signedIn) return "Signed in";
  if (info.ready) return "Ready";
  if (!info.installed) return "Not installed";
  if (!info.signedIn) return "Not signed in";
  return "Not ready";
}

function paintHarnessBanner() {
  let host = $("#harness-banner");
  if (!host) {
    const after = $("#update-banner") || $("#titlebar");
    host = document.createElement("div");
    host.id = "harness-banner";
    if (after?.parentNode) after.after(host);
    else document.body.appendChild(host);
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  const { provider } = resolvedHarness(bot);
  if (state.harnessBannerDismissed[provider]) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  const info = harnessInfo(provider);
  if (!info || info.ready) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = `<div class="update-strip harness-strip">
    <span><strong>${escapeHtml(info.label || provider)}</strong> is not ready.
    <span class="muted">${escapeHtml(info.detail || "Not signed in.")}</span></span>
    <button type="button" class="update-link" data-act="open-harness" data-id="${escapeHtml(provider)}">Open Settings</button>
    <button type="button" class="update-x" data-act="dismiss-harness-banner" data-id="${escapeHtml(provider)}" title="Dismiss">×</button>
  </div>`;
}

function harnessHtml(h) {
  const def = h.provider || "grok-build";
  const tab = state.harnessTab || def;
  const info = harnessInfo(tab);
  const tone = statusTone(info);
  const test = state.harnessTests[tab] || {};
  const models = localModels(tab);
  const modelValue =
    tab === def && h.model
      ? h.model
      : info?.model || (tab === "grok-build" || tab === "spacexai" ? "grok-4.6" : "");
  const tabs = harnessCatalog()
    .map((item) => {
      const row = harnessInfo(item.id);
      const on = tab === item.id ? "on" : "";
      const used = def === item.id ? " default" : "";
      return `<button type="button" class="harness-tab ${on}${used}" data-act="harness-tab" data-id="${item.id}">
        <i class="hdot ${statusTone(row)}"></i>
        <span>${escapeHtml(item.label)}</span>
        ${def === item.id ? `<em>default</em>` : ""}
      </button>`;
    })
    .join("");
  const modelField = models.length
    ? `<select class="field" data-harness-text="model">${models
        .map((m) => `<option value="${escapeHtml(m)}" ${modelValue === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
        .join("")}</select>`
    : `<input class="field" data-harness-text="model" value="${escapeHtml(tab === def ? h.model || "" : modelValue)}" placeholder="${
        tab === "claude" || tab === "codex" ? "CLI default" : tab === "hermes" || tab === "ollama" || tab === "lmstudio" ? "start LM Studio to list models" : "grok-4.6"
      }" />`;
  return `<h2>Harness</h2>
    <p class="muted" style="margin-top:-8px">One tab per engine. Check login, binary, and a test before you assign it to a Bot.</p>
    <div class="harness-layout">
      <div class="harness-tabs" role="tablist">${tabs}</div>
      <div class="card harness-panel">
        <div class="row">
          <div>
            <div class="lbl">${escapeHtml(info?.label || tab)}</div>
            <div class="sub">${escapeHtml(info?.detail || "Checking this Mac…")}</div>
          </div>
          <span class="hbadge ${tone}">${escapeHtml(statusLabel(info))}</span>
        </div>
        <div class="row"><div class="lbl">Binary</div><span class="muted mono">${escapeHtml(info?.binary || "—")}</span></div>
        ${info?.version ? `<div class="row"><div class="lbl">Version</div><span class="muted">${escapeHtml(info.version)}</span></div>` : ""}
        ${
          info?.extra?.email
            ? `<div class="row"><div class="lbl">Account</div><span class="muted">${escapeHtml(info.extra.email)}</span></div>`
            : ""
        }
        ${
          info?.extra?.hermesProvider
            ? `<div class="row"><div class="lbl">Hermes provider</div><span class="muted">${escapeHtml(info.extra.hermesProvider)}${
                info.extra.hermesBaseUrl ? ` · ${escapeHtml(info.extra.hermesBaseUrl)}` : ""
              }</span></div>`
            : ""
        }
        <div class="row"><div class="lbl">Model</div>${modelField}</div>
        ${
          tab === "hermes"
            ? `<div class="row"><div class="lbl">LM Studio</div><div class="sub">${
                state.localHarness?.lmstudio?.ok
                  ? `${(state.localHarness.lmstudio.models || []).length} models on :1234`
                  : "Not running. Start LM Studio so Hermes can use Qwen 3.8."
              }</div>
              <button type="button" class="pill" data-act="refresh-harness-status">Refresh</button></div>`
            : ""
        }
        ${
          tab === "spacexai"
            ? `<div class="row"><div><div class="lbl">API key</div><div class="sub">Leave blank to use XAI_API_KEY.</div></div>
          <input class="field" style="max-width:220px" type="password" data-harness-text="apiKey" placeholder="••••" /></div>`
            : ""
        }
        ${
          tab === "ollama" || tab === "lmstudio"
            ? `<div class="row"><div class="lbl">Detected</div><div class="sub">${escapeHtml(
                (info?.extra?.models || []).join(", ") || info?.detail || "—",
              )}</div>
              <button type="button" class="pill" data-act="refresh-harness-status">Refresh</button></div>`
            : ""
        }
        ${
          tab === "grok-build"
            ? `<div class="row"><div><div class="lbl">Login</div><div class="sub">${
                info?.signedIn
                  ? "Grok CLI on this Mac. It drives the Bot computer through Sub8 tools, like Claude."
                  : "Needs a browser login once."
              }</div></div>
              <button type="button" class="pill" data-act="grok-oauth">${info?.signedIn ? "Refresh session" : "Sign in"}</button></div>`
            : ""
        }
        ${
          info?.hint
            ? `<div class="row"><div class="lbl">Fix</div><div class="sub">${escapeHtml(info.hint)}</div></div>`
            : ""
        }
        <div class="row">
          <div>
            <div class="lbl">Test</div>
            <div class="sub" id="harness-ping">${escapeHtml(test.note || "Sends a one-word ping. Logs stay on this tab.")}</div>
          </div>
          <button type="button" class="pill" data-act="test-harness" data-id="${escapeHtml(tab)}" ${test.busy ? "disabled" : ""}>${
            test.busy ? "Testing…" : "Test"
          }</button>
        </div>
        <pre class="harness-log" id="harness-log">${escapeHtml(test.log || "No test yet.")}</pre>
        <div class="row">
          <div class="sub">${def === tab ? "This is the default for new Bots." : "Does not switch the default until you say so."}</div>
          ${
            def === tab
              ? ""
              : `<button type="button" class="pill primary" data-act="harness-default" data-id="${escapeHtml(tab)}">Use as default</button>`
          }
        </div>
      </div>
    </div>`;
}

function settingsHtml() {
  const s = state.settings || {};
  const h = s.harness || {};
  const sec = state.section;
  return `<div class="overlay">
    <div class="modal" data-modal="1">
      <nav class="snav">
        <button type="button" class="${sec === "general" ? "active" : ""}" data-act="sec" data-id="general">${iconGear()} <span>General</span></button>
        <button type="button" class="${sec === "harness" ? "active" : ""}" data-act="sec" data-id="harness">${iconHarness()} <span>Harness</span></button>
        <button type="button" class="${sec === "usage" ? "active" : ""}" data-act="sec" data-id="usage">${iconUsage()} <span>Usage</span></button>
        <button type="button" class="${sec === "updates" ? "active" : ""}" data-act="sec" data-id="updates">${iconMonitor()} <span>Computer</span></button>
      </nav>
      <div class="sbody">
        <button type="button" class="close" data-act="close-modal" title="Close" aria-label="Close">${iconClose()}</button>
        ${
          sec === "harness"
            ? harnessHtml(h)
            : sec === "general"
            ? `<h2>General</h2>
          <div class="block"><h3>Appearance</h3>
            <div class="card row"><div><div class="lbl">Theme</div><div class="sub">Applies to this window.</div></div>
              ${seg("themePreference", s.themePreference || "system", [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ])}
            </div>
          </div>
          <div class="block"><h3>This Mac</h3>
            <div class="card">
              <div class="row"><div class="lbl">Timezone</div><span class="muted">${escapeHtml(state.timezone || "auto")}</span></div>
              <div class="row"><div class="lbl">Version</div><span class="muted">Sub8 ${escapeHtml(state.appVersion || state.update?.currentVersion || "0.3.7")}</span></div>
              <div class="row"><div><div class="lbl">Updates</div><div class="sub">${
                state.update?.updateAvailable
                  ? `Sub8 ${escapeHtml(state.update.latestVersion)} is available`
                  : state.update?.error
                    ? escapeHtml(state.update.error)
                    : state.update?.justChecked
                      ? `Checked just now. You're on Sub8 ${escapeHtml(state.update.currentVersion || state.appVersion || "")}.`
                      : state.update
                        ? `You're on Sub8 ${escapeHtml(state.update.currentVersion || state.appVersion || "")}. Check GitHub Releases for a newer build.`
                        : "Checks GitHub Releases for a newer Sub8."
              }</div></div>
                <button class="pill" data-act="check-update">${state.updateBusy ? "Checking…" : "Check for updates"}</button></div>
              ${
                state.update?.updateAvailable
                  ? `<div class="row"><div><div class="lbl">Install</div><div class="sub">Direct download for this computer, or the site at sub8.grok.me.</div></div>
                <div class="row" style="gap:8px;justify-content:flex-end">
                  <button class="pill" data-act="open-site">sub8.grok.me</button>
                  <button class="pill primary" data-act="install-update">${
                    state.update.downloadName ? `Download ${escapeHtml(state.update.downloadName)}` : "Download"
                  }</button>
                </div></div>`
                  : ""
              }
            </div>
          </div>`
            : sec === "usage"
              ? `<h2>Usage</h2><div class="card"><div class="lbl">Plan</div><div class="muted">Usage follows your Grok Build or xAI account. Nothing is billed inside Sub8.</div></div>`
              : `<h2>Computer</h2>
          <div class="block">
            <div class="card">
              <div class="row"><div><div class="lbl">Docker</div><div class="sub">${
                dockerMissing()
                  ? escapeHtml(state.docker?.hint || "Required to run computers.")
                  : state.docker?.engine
                    ? `Running · ${escapeHtml(state.docker.engine)}`
                    : "Required. Each Bot’s computer is a Linux desktop in Docker."
              }</div></div>${
                dockerMissing()
                  ? `<button type="button" class="pill primary" data-act="recover-docker" ${state.dockerBusy ? "disabled" : ""}>${
                      state.dockerBusy ? "Recovering…" : "Recover"
                    }</button>`
                  : `<span class="muted">Ready</span>`
              }</div>
              <div class="row"><div><div class="lbl">This Bot's desktop</div><div class="sub">${
                state.bots.find((b) => b.id === state.selected)?.vm?.status === "running"
                  ? `Running · stream port ${state.bots.find((b) => b.id === state.selected)?.vm?.novncPort || "—"}`
                  : "Not attached. Reload to start or reconnect the existing computer."
              }</div></div></div>
              <div class="row"><div><div class="lbl">Reload computer</div><div class="sub">Start it if it’s down, or attach the existing one. Does not wipe files.</div></div>
                <button class="pill primary" data-act="reload-vm">Reload</button></div>
              <div class="row"><div><div class="lbl">Open in browser</div><div class="sub">Full desktop in a tab (Selkies). You can drive it there.</div></div>
                <button class="pill" data-act="open-vm-browser">Open</button></div>
              <div class="row"><div><div class="lbl">Reset computer</div><div class="sub">Destroys this Bot’s Linux desktop and makes a new empty one.</div></div>
                <button class="danger" data-act="reset-vm">Reset</button></div>
            </div>
          </div>`
        }
      </div>
    </div>
  </div>`;
}

function markChips(sel, id) {
  for (const btn of document.querySelectorAll(sel)) {
    btn.classList.toggle("on", btn.dataset.id === id);
  }
}

function syncEditorChips(bot) {
  if (!state.botEdit || !bot) return;
  const avatar = defaultAvatar(bot.avatar);
  markChips("[data-act=avatar-body]", avatar.body);
  markChips("[data-act=avatar-face]", avatar.expression);
  markChips("[data-act=avatar-anim]", avatar.animation);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bindDelegated() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target?.id === "ctx-sec-name") {
      e.preventDefault();
      const save = document.querySelector("[data-act=ctx-rename-section], [data-act=ctx-create-section]");
      save?.click();
      return;
    }
    if (e.key === "Escape" && state.teach) {
      stopTeachCapture();
      state.teach = null;
      state.teachFrames = [];
      state.deskSize = "side";
      render();
      return;
    }
    if (e.key === "Escape" && state.plusMenu) {
      state.plusMenu = false;
      render();
      return;
    }
    if (e.key === "Escape" && state.deskSize === "full" && !state.modal) {
      state.deskSize = "side";
      render();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-act=cycle-desk], [data-act=expand-pane], [data-act=open-desk], [data-act=bot-settings], [data-act=collapse-pane], [data-act=collapse-full]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const act = el.dataset.act;
    if (act === "expand-pane") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "collapse-pane") {
      state.showComputer = false;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "collapse-full") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    } else if (act === "bot-settings") {
      state.botEdit = !state.botEdit;
      if (state.botEdit) state.showComputer = true;
    } else if (act === "open-desk") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "full";
    } else {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = state.deskSize === "full" ? "side" : "full";
    }
    render();
  });
  document.addEventListener("contextmenu", (e) => {
    const msg = e.target.closest(".bubble[data-mid], .tool-list[data-mids]");
    if (msg && (msg.dataset.mid || msg.dataset.mids)) {
      e.preventDefault();
      state.ctx = {
        type: "message",
        mid: msg.dataset.mid || "",
        mids: msg.dataset.mids || "",
        x: e.clientX,
        y: e.clientY,
      };
      paintCtxMenu();
      return;
    }
    const sec = e.target.closest(".rail-sec");
    if (sec && isNamedSection(sec.dataset.sec)) {
      e.preventDefault();
      state.ctx = { type: "section", secId: sec.dataset.sec, x: e.clientX, y: e.clientY, naming: false };
      paintCtxMenu();
      return;
    }
    const rail = e.target.closest(".rail-bot");
    if (!rail) return;
    e.preventDefault();
    state.ctx = { type: "bot", botId: rail.dataset.id, x: e.clientX, y: e.clientY, sub: null, naming: false };
    paintCtxMenu();
  });
  document.addEventListener("dblclick", (e) => {
    const sec = e.target.closest(".rail-sec");
    if (!sec || !isNamedSection(sec.dataset.sec)) return;
    e.preventDefault();
    const r = sec.getBoundingClientRect();
    state.ctx = { type: "section", secId: sec.dataset.sec, x: r.right + 8, y: r.top, naming: true };
    paintCtxMenu();
  });
  document.addEventListener("click", (e) => {
    if (state.ctx && !e.target.closest("#ctx-host, .ctx-menu, .ctx-sub, .ctx-prompt")) {
      state.ctx = null;
      paintCtxMenu();
    }
    if (state.plusMenu && !e.target.closest(".plus-menu, [data-act=plus-menu]")) {
      state.plusMenu = false;
    }
    if (e.target.classList && e.target.classList.contains("overlay")) {
      if (e.target.classList.contains("docker-gate-overlay") || e.target.closest("#docker-gate")) {
        state.dockerGateDismissed = true;
        paintDockerGate();
        return;
      }
      state.modal = null;
      state.botEdit = false;
      state.editingRoutineId = null;
      render();
      return;
    }
    const el = e.target.closest("[data-act]");
    // Overlay carries data-act only as a fallback; inner modal clicks must not inherit it.
    if (!el || el.classList.contains("overlay")) return;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.tagName !== "A") {
      e.preventDefault();
    }
    const act = el.dataset.act;
    if (act === "picker" || act === "plus-menu") {
      state.plusMenu = !state.plusMenu;
      state.picker = false;
    }
    if (act === "attach-files") {
      state.plusMenu = false;
      $("#attach-file")?.click();
      return;
    }
    if (act === "drop-attach") {
      const i = Number(el.dataset.i);
      if (Number.isFinite(i)) state.attachments.splice(i, 1);
    }
    if (act === "teach-task") {
      state.plusMenu = false;
      state.botEdit = false;
      state.showComputer = true;
      state.deskSize = "full";
      state.teach = "ready";
      state.teachFrames = [];
      setHumanControl(true);
    }
    if (act === "start-teach") {
      state.teach = "recording";
      state.teachFrames = [];
      startTeachCapture(state.selected);
    }
    if (act === "stop-teach") {
      stopTeachCapture();
      finishTeach();
      return;
    }
    if (act === "close-teach") {
      stopTeachCapture();
      state.teach = null;
      state.teachFrames = [];
      state.deskSize = "side";
    }
    if (act === "vault") {
      openVault();
      return;
    }
    if (act === "vault-group") {
      state.vaultGroup = el.dataset.id;
      state.vaultEditId = null;
      state.vaultReveal = false;
      const host = $("#modal-host");
      if (host) delete host.dataset.key;
    }
    if (act === "vault-add-group") {
      addVaultGroup();
      return;
    }
    if (act === "vault-add-account") {
      state.vaultEditId = "new";
      state.vaultReveal = false;
      const host = $("#modal-host");
      if (host) delete host.dataset.key;
    }
    if (act === "vault-edit") {
      state.vaultEditId = el.dataset.id;
      state.vaultReveal = false;
      const host = $("#modal-host");
      if (host) delete host.dataset.key;
    }
    if (act === "vault-cancel") {
      state.vaultEditId = null;
      state.vaultReveal = false;
      const host = $("#modal-host");
      if (host) delete host.dataset.key;
    }
    if (act === "vault-reveal") {
      toggleVaultReveal();
      return;
    }
    if (act === "vault-save") {
      saveVaultAccount();
      return;
    }
    if (act === "vault-delete") {
      deleteVaultAccount(el.dataset.id);
      return;
    }
    if (act === "settings") {
      state.modal = "settings";
      state.section = "general";
    }
    if (act === "profile") {
      state.modal = "settings";
      state.section = "general";
    }
    if (act === "advanced") {
      state.modal = "advanced";
    }
    if (act === "stop-turn") {
      stopTurn();
      return;
    }
    if (act === "dismiss-docker-gate") {
      state.dockerGateDismissed = true;
      paintDockerGate();
      return;
    }
    if (act === "recover-docker") {
      recoverDocker();
      return;
    }
    if (act === "close-modal") {
      state.modal = null;
      state.botEdit = false;
      state.editingRoutineId = null;
    }
    if (act === "sec") {
      state.section = el.dataset.id;
      if (el.dataset.id === "harness") {
        state.harnessTab = state.settings?.harness?.provider || state.harnessTab || "grok-build";
        loadHarnessStatus().then(() => {
          if (state.modal === "settings" && state.section === "harness") paintModal();
        });
        const h = state.settings?.harness;
        if (h && (h.provider === "grok-build" || h.provider === "spacexai") && !grokModels().includes(h.model)) {
          const harness = { ...h, model: "grok-4.6", baseUrl: "https://api.x.ai/v1" };
          state.settings = { ...(state.settings || {}), harness };
          api("/api/settings", { method: "PUT", body: { harness } });
        }
        loadLocalHarness().then(() => paintModal());
      }
    }
    if (act === "select") {
      rememberSelected(el.dataset.id);
      state.picker = false;
      state.botEdit = false;
      state.confirmDeleteId = null;
      state.humanControl = false;
      const picked = state.bots.find((b) => b.id === el.dataset.id);
      if (picked?.unread) {
        picked.unread = false;
        api(`/api/bots/${picked.id}`, { method: "PATCH", body: { unread: false } });
      }
      loadBotHistory(el.dataset.id);
    }
    if (act === "create") {
      resetCreateForm();
      state.modal = "create";
      state.picker = false;
      loadLocalHarness().then(() => {
        if (state.modal === "create") rebuildCreateModal();
      });
    }
    if (act === "confirm-create") {
      confirmCreateBot();
      return;
    }
    if (act === "toggle-computer" || act === "collapse-pane") {
      state.showComputer = false;
      state.botEdit = false;
      state.deskSize = "side";
    }
    if (act === "expand-pane") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    }
    if (act === "collapse-full") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "side";
    }
    if (act === "open-desk") {
      state.showComputer = true;
      state.botEdit = false;
      state.deskSize = "full";
    }
    if (act === "cycle-desk" || act === "expand-pane" || act === "open-desk" || act === "collapse-pane") {
      return;
    }
    if (act === "bot-settings") {
      return;
    }
    if (act === "bot-settings") {
      state.botEdit = !state.botEdit;
      if (state.botEdit) state.showComputer = true;
    }
    if (act === "edit-bot") {
      if (el.dataset.id) state.selected = el.dataset.id;
      state.botEdit = true;
      state.showComputer = true;
      state.picker = false;
      state.modal = null;
    }
    if (act === "bot-color") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot && el.dataset.color) {
        bot.color = el.dataset.color;
        api(`/api/bots/${bot.id}`, { method: "PATCH", body: { color: bot.color } });
        refreshAvatars();
      }
    }
    if (act === "avatar-body" || act === "avatar-face" || act === "avatar-anim") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        const field = act === "avatar-body" ? "body" : act === "avatar-face" ? "expression" : "animation";
        bot.avatar = defaultAvatar({
          ...(bot.avatar || {}),
          [field]: el.dataset.id,
        });
        api(`/api/bots/${bot.id}`, { method: "PATCH", body: { avatar: bot.avatar } });
        syncEditorChips(bot);
        refreshAvatars();
      }
      return;
    }
    if (act === "create-face") {
      state.createFace = el.dataset.id;
      markChips("[data-act=create-face]", el.dataset.id);
      refreshAvatars();
      return;
    }
    if (act === "bot-notify") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        bot.notificationsEnabled = !bot.notificationsEnabled;
        api(`/api/bots/${bot.id}`, {
          method: "PATCH",
          body: { notificationsEnabled: bot.notificationsEnabled },
        });
      }
    }
    if (act === "save-bot") {
      saveBot();
      return;
    }
    if (act === "delete-bot") {
      state.deleteBotId = el.dataset.id;
      state.modal = "delete-bot";
      state.botEdit = false;
      loadComputers().then(() => render());
      render();
      return;
    }
    if (act === "delete-bot-go") {
      deleteBot(state.deleteBotId, el.dataset.keep !== "0");
      return;
    }
    if (act === "computers") {
      state.modal = "computers";
      state.computerAttach = false;
      loadComputers().then(() => {
        if (!state.computerId) state.computerId = state.computers[0]?.id || null;
        paintModal();
        refreshComputerPreviews();
      });
      render();
      return;
    }
    if (act === "computer-view") {
      state.computerView = el.dataset.id === "list" ? "list" : "grid";
      try {
        localStorage.setItem("sub8.computerView", state.computerView);
      } catch {
        /* ignore */
      }
      paintModal();
      return;
    }
    if (act === "open-computer-bot") {
      const id = el.dataset.id;
      if (!id) return;
      state.modal = null;
      state.computerAttach = false;
      rememberSelected(id);
      state.picker = false;
      state.botEdit = false;
      state.confirmDeleteId = null;
      state.humanControl = false;
      const picked = state.bots.find((b) => b.id === id);
      if (picked?.unread) {
        picked.unread = false;
        api(`/api/bots/${picked.id}`, { method: "PATCH", body: { unread: false } });
      }
      render();
      loadBotHistory(id);
      return;
    }
    if (act === "computer-select") {
      state.computerId = el.dataset.id;
      state.computerAttach = false;
      paintModal();
      return;
    }
    if (act === "computer-attach-open") {
      state.computerId = el.dataset.id;
      state.computerAttach = true;
      paintModal();
      return;
    }
    if (act === "computer-attach") {
      computerAction(el.dataset.id, "attach", { botId: el.dataset.bot });
      return;
    }
    if (act === "computer-act") {
      const doit = el.dataset.do;
      if (doit === "destroy" && !confirm("Destroy this computer and its files? This cannot be undone.")) return;
      computerAction(el.dataset.id, doit);
      return;
    }
    if (act === "reset-vm") {
      if (confirm("Reset this Bot’s computer? Files and logins on that desktop will be gone.")) resetVm();
      return;
    }
    if (act === "check-update") {
      state.updateBusy = true;
      paintModal();
      checkForUpdate({ silent: false }).finally(() => {
        state.updateBusy = false;
        paintModal();
      });
      return;
    }
    if (act === "install-update") {
      openDownload();
      return;
    }
    if (act === "open-site") {
      openOfficialSite();
      return;
    }
    if (act === "dismiss-update") {
      dismissUpdateBanner();
      return;
    }
    if (act === "reload-vm" || act === "desk-start-new") {
      resumeVm();
      return;
    }
    if (act === "refresh-stream") {
      reconnectStream();
      return;
    }
    if (act === "reboot-vm") {
      rebootVm();
      return;
    }
    if (act === "open-vm-browser") {
      const bot = state.bots.find((b) => b.id === state.selected);
      const port = bot?.vm?.novncPort;
      if (port) window.open(`http://127.0.0.1:${port}/`, "_blank");
      else resumeVm().then(() => {
        const b = state.bots.find((x) => x.id === state.selected);
        if (b?.vm?.novncPort) window.open(`http://127.0.0.1:${b.vm.novncPort}/`, "_blank");
      });
      return;
    }
    if (act === "add-routine") {
      state.modal = "routine";
      state.editingRoutineId = null;
      render();
      return;
    }
    if (act === "edit-routine") {
      state.modal = "routine";
      state.editingRoutineId = el.dataset.id;
      render();
      return;
    }
    if (act === "delete-routine") {
      deleteRoutine(el.dataset.id);
      return;
    }
    if (act === "toggle-routine") {
      toggleRoutine(el.dataset.id);
      return;
    }
    if (act === "routine-group") {
      const hidden = $("#rg");
      if (hidden) hidden.value = el.dataset.id;
      document.querySelectorAll("#rg-seg .seg-btn").forEach((b) => b.classList.toggle("on", b === el));
      return;
    }
    if (act === "routine-enabled") {
      el.classList.toggle("on");
      return;
    }
    if (act === "save-routine") {
      saveRoutine();
      return;
    }
    if (act === "dictate") {
      toggleDictate();
      return;
    }
    if (act === "send") $("#send")?.dispatchEvent(new Event("submit"));
    if (act === "ctx-pin") {
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.pinned = !b.pinned;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { pinned: b.pinned } });
      }
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-move-open") {
      if (state.ctx) state.ctx = { ...state.ctx, sub: state.ctx.sub === "move" ? null : "move", naming: false };
      paintCtxMenu();
      return;
    }
    if (act === "ctx-new-section") {
      if (state.ctx) state.ctx = { ...state.ctx, type: "bot", naming: true, sub: "move" };
      paintCtxMenu();
      return;
    }
    if (act === "ctx-rename-section-open") {
      if (state.ctx?.type === "section") state.ctx = { ...state.ctx, naming: true };
      else {
        const sec = sidebarSections().find((s) => s.id === el.dataset.sec);
        if (sec) state.ctx = { type: "section", secId: sec.id, x: state.ctx?.x || 80, y: state.ctx?.y || 80, naming: true };
      }
      paintCtxMenu();
      return;
    }
    if (act === "ctx-rename-section") {
      const id = el.dataset.sec || state.ctx?.secId;
      const name = ($("#ctx-sec-name")?.value || "").trim();
      if (!id || !name) return;
      const sections = sidebarSections().map((s) => (s.id === id ? { ...s, name } : s));
      state.settings = { ...(state.settings || {}), sidebarSections: sections };
      api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-del-msg") {
      const ids = [state.ctx?.mid, ...(String(state.ctx?.mids || "").split(","))]
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      state.ctx = null;
      paintCtxMenu();
      if (ids.length) deleteMessages(ids);
      return;
    }
    if (act === "ctx-delete-section") {
      const id = el.dataset.sec || state.ctx?.secId;
      if (!id) return;
      const sec = sidebarSections().find((s) => s.id === id);
      if (sec && !confirm(`Delete “${sec.name}”? Bots in it stay, ungrouped.`)) return;
      const sections = sidebarSections().filter((s) => s.id !== id);
      state.settings = { ...(state.settings || {}), sidebarSections: sections };
      for (const b of state.bots) {
        if (b.section === id) {
          b.section = "";
          api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: "" } });
        }
      }
      api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-create-section") {
      const name = ($("#ctx-sec-name")?.value || "").trim();
      if (!name) return;
      const id = `sec_${Date.now().toString(36)}`;
      const sections = [...sidebarSections(), { id, name }];
      state.settings = { ...(state.settings || {}), sidebarSections: sections };
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.section = id;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: id } });
      }
      api("/api/settings", { method: "PUT", body: { sidebarSections: sections } }).then(refreshSettings);
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-move") {
      const sec = el.dataset.sec || "";
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.section = sec;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { section: sec } });
      }
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-unread") {
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.unread = !b.unread;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { unread: b.unread } });
      }
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-edit") {
      rememberSelected(el.dataset.id);
      state.botEdit = true;
      state.showComputer = true;
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-dup") {
      api(`/api/bots/${el.dataset.id}/duplicate`, { method: "POST" }).then((copy) => {
        if (copy?.id) rememberSelected(copy.id);
        state.ctx = null;
        return refresh();
      });
      return;
    }
    if (act === "ctx-copy") {
      navigator.clipboard?.writeText(el.dataset.id || "");
      state.ctx = null;
      paintCtxMenu();
      return;
    }
    if (act === "ctx-hide") {
      const b = state.bots.find((x) => x.id === el.dataset.id);
      if (b) {
        b.hidden = !b.hidden;
        api(`/api/bots/${b.id}`, { method: "PATCH", body: { hidden: b.hidden } });
        if (b.hidden && state.selected === b.id) {
          const next = state.bots.find((x) => !x.hidden && x.id !== b.id);
          rememberSelected(next?.id || null);
        }
      }
      state.ctx = null;
      render();
      return;
    }
    if (act === "ctx-del") {
      const id = el.dataset.id;
      state.ctx = null;
      paintCtxMenu();
      if (id) {
        state.deleteBotId = id;
        state.modal = "delete-bot";
        loadComputers().then(() => render());
        render();
      }
      return;
    }
    if (act === "set-pref") {
      state.settings = { ...(state.settings || {}), [el.dataset.set]: el.dataset.id };
      applyTheme();
      paintModal();
      api("/api/settings", { method: "PUT", body: { [el.dataset.set]: el.dataset.id } }).then(async () => {
        await refreshSettings();
        applyTheme();
      });
      return;
    }
    if (act === "harness-tab") {
      state.harnessTab = el.dataset.id;
      paintModal();
      return;
    }
    if (act === "refresh-harness-status") {
      loadHarnessStatus().then(() => {
        paintModal();
        paintHarnessBanner();
      });
      return;
    }
    if (act === "open-harness") {
      state.modal = "settings";
      state.section = "harness";
      state.harnessTab = el.dataset.id || state.harnessTab;
      render();
      loadHarnessStatus().then(() => paintModal());
      return;
    }
    if (act === "dismiss-harness-banner") {
      const id = el.dataset.id;
      if (id) state.harnessBannerDismissed[id] = true;
      paintHarnessBanner();
      return;
    }
    if (act === "set-harness" || act === "harness-default") {
      const provider = el.dataset.id;
      const harness = { ...(state.settings?.harness || {}), provider };
      if (provider === "ollama") {
        harness.baseUrl = "http://127.0.0.1:11434/v1";
        harness.model = pickModelForProvider("ollama", harness.model);
      } else if (provider === "lmstudio") {
        harness.baseUrl = "http://127.0.0.1:1234/v1";
        harness.model = pickModelForProvider("lmstudio", harness.model);
      } else if (provider === "claude" || provider === "codex" || provider === "hermes") {
        harness.model = "";
        harness.baseUrl = "https://api.x.ai/v1";
      } else {
        harness.model = pickModelForProvider(provider, "grok-4.6");
        harness.baseUrl = "https://api.x.ai/v1";
        harness.apiKeyEnv = "XAI_API_KEY";
      }
      state.settings = { ...(state.settings || {}), harness };
      state.harnessTab = provider;
      paintModal();
      api("/api/settings", { method: "PUT", body: { harness } }).then(async () => {
        await refreshSettings();
        await loadHarnessStatus();
        paintModal();
        render();
        paintHarnessBanner();
        if (provider === "grok-build") {
          if (state.hasGrokAuth === false) {
            state.grokAuthAsk = true;
            paintGrokAuth();
          }
          startGrokOAuth();
        }
      });
      return;
    }
    if (act === "take-control") {
      setHumanControl(true);
      return;
    }
    if (act === "release-control") {
      setHumanControl(false);
      return;
    }
    if (act === "refresh-local-harness") {
      if (state.modal === "create") snapshotCreateForm();
      loadLocalHarness().then(() => {
        if (state.modal === "create") rebuildCreateModal();
        else paintModal();
        if (state.botEdit) {
          const bot = state.bots.find((b) => b.id === state.selected);
          const host = $("#bot-editor");
          if (host) delete host.dataset.bot;
          if (bot) paintBotEditor(bot);
        }
      });
      return;
    }
    if (act === "test-harness") {
      testHarness(el.dataset.id);
      return;
    }
    if (act === "grok-oauth") {
      startGrokOAuth();
      return;
    }
    if (act === "grok-auth-later") {
      state.grokAuthAsk = "later";
      paintGrokAuth();
      return;
    }
    if (act === "grok-auth-now") {
      state.grokAuthAsk = "pending";
      paintGrokAuth();
      startGrokOAuth();
      return;
    }
    render();
  });
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.set) {
      await api("/api/settings", { method: "PUT", body: { [el.dataset.set]: el.value } });
      await refreshSettings();
    }
    if (el.dataset.harness) {
      const harness = { ...state.settings.harness, [el.dataset.harness]: el.value };
      if (el.value === "spacexai") {
        harness.baseUrl = "https://api.x.ai/v1";
        harness.apiKeyEnv = "XAI_API_KEY";
      }
      await api("/api/settings", { method: "PUT", body: { harness } });
      await refreshSettings();
    }
    if (el.dataset.harnessText) {
      const tab = state.harnessTab || state.settings?.harness?.provider;
      if (tab === "hermes" && el.dataset.harnessText === "model") {
        await api("/api/harness/hermes", { method: "PUT", body: { model: el.value } });
        if (state.harnessStatus?.harnesses?.hermes) state.harnessStatus.harnesses.hermes.model = el.value;
        await loadHarnessStatus();
        paintModal();
        return;
      }
      if (tab && tab !== (state.settings?.harness?.provider || "grok-build") && el.dataset.harnessText === "model") {
        return;
      }
      const harness = { ...state.settings.harness, [el.dataset.harnessText]: el.value };
      await api("/api/settings", { method: "PUT", body: { harness } });
      await refreshSettings();
    }
    if (el.id === "bot-color-pick") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot && el.value) {
        bot.color = el.value;
        api(`/api/bots/${bot.id}`, { method: "PATCH", body: { color: bot.color } });
        refreshAvatars();
      }
    }
    if (el.id === "ch") {
      snapshotCreateForm();
      state.createHarness = el.value;
      state.createModel = pickModelForProvider(el.value, state.createModel);
      rebuildCreateModal();
    }
    if (el.id === "cm") {
      state.createModel = el.value;
    }
    if (el.id === "bh") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        const provider = el.value;
        const prev = bot.harness?.model || "";
        bot.harness = {
          ...(bot.harness || {}),
          provider,
          model: pickModelForProvider(provider, prev),
        };
        const host = $("#bot-editor");
        if (host) delete host.dataset.bot;
        paintBotEditor(bot);
      }
    }
    if (el.id === "bm") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) bot.harness = { ...(bot.harness || {}), model: el.value };
    }
    if (el.dataset.computerName) {
      const id = el.dataset.computerName;
      const name = el.value.trim();
      if (!name) return;
      api(`/api/computers/${id}`, { method: "PATCH", body: { name } }).then(() => loadComputers());
    }
    if (el.dataset.computerSort != null || el.classList.contains("csort")) {
      state.computerSort = el.value || "name";
      try {
        localStorage.setItem("sub8.computerSort", state.computerSort);
      } catch {
        /* ignore */
      }
      paintModal();
    }
  });
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-tog]");
    if (!el) return;
    const key = el.dataset.tog;
    await api("/api/settings", { method: "PUT", body: { [key]: !state.settings[key] } });
    await refreshSettings();
    render();
  });
}

async function startGrokOAuth() {
  const note = $("#harness-ping");
  if (note) note.textContent = "Signing in…";
  try {
    const r = await api("/api/harness/grok-login", { method: "POST", body: { botId: state.selected } });
    if (note) note.textContent = r.message || (r.reused ? "Reused this Mac’s Grok session." : "Sign-in started.");
    if (r.reused && !r.needHostLogin) {
      state.hasGrokAuth = true;
      state.grokAuthAsk = false;
      paintGrokAuth();
    }
    if (r.needHostLogin && !state.hasGrokAuth) {
      state.grokAuthAsk = true;
      paintGrokAuth();
      const end = Date.now() + 180_000;
      const poll = async () => {
        if (Date.now() > end) return;
        try {
          const again = await api("/api/harness/grok-login", { method: "POST", body: { botId: state.selected } });
          if (again.reused && !again.needHostLogin) {
            if (note) note.textContent = again.message || "Signed in.";
            state.hasGrokAuth = true;
            state.grokAuthAsk = false;
            paintGrokAuth();
            return;
          }
        } catch {
          /* keep polling */
        }
        setTimeout(poll, 3000);
      };
      poll();
    }
  } catch (err) {
    if (note) note.textContent = `OAuth failed · ${err.message}`;
  }
}

async function testHarness(provider) {
  const id = provider || state.harnessTab || state.settings?.harness?.provider || "grok-build";
  state.harnessTests[id] = { ...(state.harnessTests[id] || {}), busy: true, note: "Testing…" };
  if (state.modal === "settings" && state.section === "harness") paintModal();
  try {
    const r = await api("/api/harness/test", { method: "POST", body: { botId: state.selected, provider: id } });
    const line = r.ok
      ? `OK · ${r.provider || id} · ${r.model || "default"}`
      : `Failed · ${r.error || "no reply"}`;
    state.harnessTests[id] = {
      busy: false,
      note: line,
      log: String(r.log || r.sample || r.error || "").trim() || line,
      ok: Boolean(r.ok),
      at: r.at || Date.now(),
    };
  } catch (err) {
    state.harnessTests[id] = { busy: false, note: `Failed · ${err.message}`, log: err.message, ok: false };
  }
  if (state.modal === "settings" && state.section === "harness") paintModal();
}

async function loadHarnessStatus() {
  try {
    state.harnessStatus = await api("/api/harness/status");
    if (state.harnessStatus?.local) state.localHarness = { ...state.localHarness, ...state.harnessStatus.local };
    paintHarnessBanner();
    return state.harnessStatus;
  } catch {
    return null;
  }
}

let teachTimer = null;

function stopTeachCapture() {
  if (teachTimer) {
    clearInterval(teachTimer);
    teachTimer = null;
  }
}

function imageAtLeast(dataUrl, min) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width >= min && img.height >= min);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function startTeachCapture(botId) {
  stopTeachCapture();
  const grab = async () => {
    if (state.teach !== "recording" || !botId) return;
    try {
      const res = await fetch(`/api/bots/${botId}/screen?t=${Date.now()}`);
      if (!res.ok) return;
      const url = await blobToDataUrl(await res.blob());
      state.teachFrames.push(url);
      if (state.teachFrames.length > 16) state.teachFrames.shift();
    } catch {
      /* ignore */
    }
  };
  grab();
  teachTimer = setInterval(grab, 2000);
}

async function finishTeach() {
  const bot = state.bots.find((b) => b.id === state.selected);
  const frames = [...state.teachFrames];
  state.teach = null;
  state.teachFrames = [];
  state.deskSize = "side";
  render();
  if (!bot) return;
  const name = `Taught task ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  bot.busy = true;
  bot.messages.push({
    id: `pending-${Date.now()}`,
    role: "user",
    content: `Learn this task I just demonstrated (${name}).`,
    ts: Date.now(),
  });
  paintChat(bot);
  try {
    await api(`/api/bots/${bot.id}/teach`, { method: "POST", body: { name, frames } });
  } catch (err) {
    bot.busy = false;
    bot.messages.push({
      id: `e${Date.now()}`,
      role: "assistant",
      content: `Couldn’t save that task: ${err.message}`,
      ts: Date.now(),
    });
    paintChat(bot);
  }
}

async function onAttachFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  for (const file of files) {
    const item = { name: file.name, type: file.type || "file", dataUrl: "", text: "" };
    if (file.type.startsWith("image/")) {
      item.dataUrl = await blobToDataUrl(file);
      const big = await imageAtLeast(item.dataUrl, 8);
      if (!big) {
        item.text = `(skipped ${file.name}: image must be at least 8×8)`;
        item.dataUrl = "";
      }
    } else if (file.size < 80_000) {
      item.text = await file.text();
    }
    state.attachments.push(item);
  }
  render();
}

let dictateCtl = null;

function setMicUI(on, err) {
  const btn = $(".composer-mic");
  const input = $("#send")?.q;
  if (btn) {
    btn.classList.toggle("on", on);
    btn.title = on ? "Stop listening" : "Speak";
  }
  if (input && err) input.placeholder = err;
  else if (input && state.selected) {
    const bot = state.bots.find((b) => b.id === state.selected);
    if (on) input.placeholder = "Listening… click the mic when you’re done";
    else if (bot) input.placeholder = `Message ${bot.name}`;
  }
}

function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buf;
}

async function toggleDictate() {
  if (dictateCtl) {
    dictateCtl.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    setMicUI(false, "Allow Microphone for Sub8 in System Settings → Privacy.");
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    dictateCtl = null;
    if (rec.state !== "inactive") rec.stop();
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const input = $("#send")?.q;
    if (blob.size < 2000) {
      setMicUI(false, "That was too short. Click mic, talk, click mic again.");
      return;
    }
    if (input) input.placeholder = "Transcribing…";
    try {
      const res = await fetch("/api/dictate", {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: await blob.arrayBuffer(),
      });
      const data = await res.json().catch(() => ({}));
      if (data.text && input) {
        input.value = `${input.value}${input.value ? " " : ""}${data.text}`.trim();
        input.focus();
        setMicUI(false);
      } else {
        setMicUI(false, data.error || "Couldn’t transcribe that. Try again.");
      }
    } catch (err) {
      setMicUI(false, err.message || "Dictate failed.");
    }
  };
  rec.start(200);
  dictateCtl = { stop: finish };
  setMicUI(true);
  setTimeout(() => dictateCtl?.stop(), 30_000);
}

function sizeComposer() {
  const ta = $("#send")?.q;
  if (!ta || ta.tagName !== "TEXTAREA") return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
}

function onComposerKey(e) {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return;
  e.preventDefault();
  $("#send")?.requestSubmit?.() || $("#send")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

async function onSend(e) {
  e.preventDefault();
  const input = e.target.q;
  const text = input.value.trim();
  const files = state.attachments;
  if ((!text && !files.length) || !state.selected) return;
  input.value = "";
  state.draft = "";
  state.attachments = [];
  state.chatFollow = true;
  sizeComposer();
  const images = files.filter((f) => f.dataUrl).map((f) => f.dataUrl);
  const extras = files
    .filter((f) => f.text)
    .map((f) => `\n\nAttached ${f.name}:\n${f.text.slice(0, 4000)}`)
    .join("");
  const names = files.map((f) => f.name).join(", ");
  const content = [text, names && !text ? `Attached ${names}` : names && text ? `(attached ${names})` : "", extras]
    .filter(Boolean)
    .join(" ");
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) {
    bot.busy = true;
    bot.messages.push({ id: `pending-${Date.now()}`, role: "user", content, ts: Date.now() });
    paintChat(bot);
    refreshAvatars();
  }
  await api(`/api/bots/${state.selected}/messages`, { method: "POST", body: { content, images } });
}

async function createBot() {
  resetCreateForm();
  state.modal = "create";
  state.picker = false;
  render();
  await loadLocalHarness();
  if (state.modal === "create") rebuildCreateModal();
}

async function openVault() {
  try {
    state.vault = await api("/api/vault");
  } catch (err) {
    window.alert(err?.message || "Could not open the vault.");
    return;
  }
  state.modal = "vault";
  state.vaultEditId = null;
  state.vaultReveal = false;
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function addVaultGroup() {
  const name = window.prompt("Group name");
  if (!name || !name.trim()) return;
  await api("/api/vault/groups", { method: "POST", body: { name: name.trim() } });
  state.vault = await api("/api/vault");
  const g = (state.vault.groups || []).at(-1);
  if (g) state.vaultGroup = g.id;
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

function toggleVaultReveal() {
  const input = $("#v-pass");
  const isNew = state.vaultEditId === "new";
  if (!isNew && !state.vaultReveal && input && input.value === "••••") {
    api(`/api/vault/accounts/${state.vaultEditId}/reveal`)
      .then((acc) => {
        state.vaultReveal = true;
        if (input) {
          input.type = "text";
          input.value = acc.password || "";
        }
      })
      .catch((err) => window.alert(err?.message || "Could not reveal."));
    return;
  }
  state.vaultReveal = !state.vaultReveal;
  if (input) input.type = state.vaultReveal ? "text" : "password";
}

async function saveVaultAccount() {
  const body = {
    label: $("#v-label")?.value || "",
    site: $("#v-site")?.value || "",
    username: $("#v-user")?.value || "",
    notes: $("#v-notes")?.value || "",
    groupId: $("#v-group")?.value || "",
  };
  const pass = $("#v-pass")?.value;
  if (pass && pass !== "••••") body.password = pass;
  let acc;
  if (state.vaultEditId && state.vaultEditId !== "new") {
    acc = await api(`/api/vault/accounts/${state.vaultEditId}`, { method: "PATCH", body });
  } else {
    acc = await api("/api/vault/accounts", { method: "POST", body });
  }
  const allowed = [...document.querySelectorAll("[data-vault-bot]:checked")].map((el) => el.dataset.vaultBot);
  for (const bot of state.bots) {
    const cur = new Set(state.vault.grants?.[bot.id] || []);
    if (allowed.includes(bot.id)) cur.add(acc.id);
    else cur.delete(acc.id);
    await api(`/api/vault/grants/${bot.id}`, { method: "PUT", body: { accountIds: [...cur] } });
  }
  state.vault = await api("/api/vault");
  state.vaultEditId = acc.id;
  state.vaultReveal = false;
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function deleteVaultAccount(id) {
  if (!id || !window.confirm("Delete this login? Bots will lose access.")) return;
  state.vault = await api(`/api/vault/accounts/${id}`, { method: "DELETE" });
  state.vaultEditId = null;
  const host = $("#modal-host");
  if (host) delete host.dataset.key;
  render();
}

async function confirmCreateBot() {
  snapshotCreateForm();
  const name = (state.createName || "").trim() || "New Bot";
  const description = (state.createDesc || "").trim();
  const face = state.createFace;
  const provider = state.createHarness || "default";
  const model = (state.createModel || "").trim();
  const harness = { provider };
  if (model) harness.model = model;
  const btn = $("#confirm-create");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Creating…";
  }
  try {
    const bot = await api("/api/bots", {
      method: "POST",
      body: {
        name,
        description,
        avatar: defaultAvatar({ expression: face, animation: "idle" }),
        harness,
      },
    });
    resetCreateForm();
    rememberSelected(bot.id);
    state.modal = null;
    state.picker = false;
    await refresh();
    const live = state.bots.find((b) => b.id === bot.id) || bot;
    if (live && !live.vm?.detached) {
      if (!live.vm?.status || live.vm.status === "idle") {
        live.vm = { ...(live.vm || {}), status: "starting", hint: "Starting the computer…" };
      }
      attachLiveFrame(live);
      if (!live.vm?.novncPort && live.vm?.status !== "starting") resumeVm().catch(() => {});
    }
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Create Bot";
    }
    window.alert(err?.message || "Could not create the bot.");
  }
}

async function saveRoutine() {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  const current = (bot.routines || []).find((r) => r.id === state.editingRoutineId);
  const body = {
    name: $("#rn")?.value || "Routine",
    instruction: $("#ri")?.value || "",
  };
  if (current?.schedule?.type === "daily") body.schedule = current.schedule;
  else if (!current) {
    const morningSchedule = morningScheduleFromInstruction(body.instruction);
    if (morningSchedule) body.schedule = morningSchedule;
    else body.interval_minutes = Number($("#rm")?.value || 15);
  } else body.interval_minutes = Number($("#rm")?.value || 15);
  if (!current) {
    body.force_new = true;
    body.solo = false;
  }
  if (!body.instruction.trim()) return;
  if (state.editingRoutineId) {
    body.enabled = $("#re-tog") ? $("#re-tog").classList.contains("on") : true;
    await api(`/api/bots/${bot.id}/routines/${state.editingRoutineId}`, { method: "PATCH", body });
  } else {
    await api(`/api/bots/${bot.id}/routines`, { method: "POST", body });
  }
  state.modal = null;
  state.editingRoutineId = null;
  await refresh();
}

async function deleteRoutine(id) {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || !id) return;
  bot.routines = (bot.routines || []).filter((r) => r.id !== id);
  paintRoutineList(bot);
  if (state.editingRoutineId === id) {
    state.editingRoutineId = null;
    state.modal = null;
  }
  try {
    await api(`/api/bots/${bot.id}/routines/${id}`, { method: "DELETE" });
  } catch {
    await refresh();
    return;
  }
  await refresh();
}

async function toggleRoutine(id) {
  const bot = state.bots.find((b) => b.id === state.selected);
  const r = (bot?.routines || []).find((x) => x.id === id);
  if (!bot || !r) return;
  await api(`/api/bots/${bot.id}/routines/${id}`, {
    method: "PATCH",
    body: { enabled: r.enabled === false },
  });
  await refresh();
}

async function deleteBot(id, keepComputer = true) {
  if (!id) return;
  forgottenBots.add(id);
  state.bots = state.bots.filter((b) => b.id !== id);
  state.confirmDeleteId = null;
  state.deleteBotId = null;
  state.botEdit = false;
  state.modal = null;
  if (state.selected === id) rememberSelected(state.bots.find((b) => !b.hidden)?.id || null);
  render();
  try {
    await api(`/api/bots/${id}`, { method: "DELETE", body: { keepComputer: Boolean(keepComputer) } });
  } catch (err) {
    forgottenBots.delete(id);
    window.alert(err?.message || "Could not delete the bot.");
    await refresh();
    return;
  }
  await refresh();
  loadComputers();
}

async function refreshComputerPreviews() {
  try {
    await api("/api/computers/previews", { method: "POST", body: {} });
    state.previewTick = Date.now();
    if (state.modal === "computers") paintModal();
  } catch {
    /* docker may be busy */
  }
}

async function recoverDocker() {
  if (state.dockerBusy) return;
  state.dockerBusy = true;
  paintDockerGate();
  if (state.modal === "computers" || state.modal === "settings") paintModal();
  try {
    const r = await api("/api/docker/recover", { method: "POST", body: {} });
    if (r.docker) state.docker = r.docker;
    if (Array.isArray(r.computers)) state.computers = r.computers;
    if (r.ok) state.dockerGateDismissed = false;
    await refresh();
    await loadComputers();
    if (!r.ok) window.alert(r.docker?.hint || r.error || "Docker is still not answering.");
  } catch (err) {
    window.alert(err?.message || "Could not recover Docker.");
  } finally {
    state.dockerBusy = false;
    paintDockerGate();
    if (state.modal === "computers" || state.modal === "settings") paintModal();
  }
}

async function loadComputers() {
  try {
    const r = await api("/api/computers");
    state.computers = r.computers || [];
    if (r.docker) {
      const was = dockerMissing();
      state.docker = r.docker;
      if (was !== dockerMissing()) paintDockerGate();
    }
    if (state.computerId && !state.computers.some((c) => c.id === state.computerId)) {
      state.computerId = state.computers[0]?.id || null;
    }
    if (state.modal === "computers") paintModal();
    const bar = $("#titlebar");
    if (bar) delete bar.dataset.stamp;
    paintTitle(state.bots.find((b) => b.id === state.selected));
    return state.computers;
  } catch {
    return state.computers;
  }
}

function paintComputerStats() {
  for (const [name, st] of Object.entries(state.computerStats || {})) {
    document.querySelectorAll(`[data-cmem="${CSS.escape(name)}"]`).forEach((el) => {
      const pct = Math.max(0, Math.min(100, Number(st.memPct) || 0));
      const fill = el.querySelector("[data-cmem-fill]");
      const lab = el.querySelector("[data-cmem-label]");
      if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle("hot", pct >= 85);
        fill.classList.toggle("warm", pct >= 60 && pct < 85);
        fill.classList.toggle("ok", pct < 60);
      }
      if (lab) lab.textContent = (st.mem || "—").replace(/iB$/i, "B");
    });
  }
}

async function loadComputerStats() {
  if (state.modal !== "computers") return;
  try {
    const r = await api("/api/computers/stats");
    state.computerStats = r.stats || {};
    paintComputerStats();
  } catch {
    /* ignore */
  }
}

async function computerAction(id, action, body = {}) {
  try {
    const r = await api(`/api/computers/${id}/${action}`, { method: "POST", body });
    state.computers = r.computers || state.computers;
    state.computerAttach = false;
    if (state.modal === "computers") paintModal();
    await refresh();
    loadComputerStats();
  } catch (err) {
    window.alert(err?.message || "That computer action failed.");
  }
}

async function saveBot() {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  await api(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: {
      name: $("#bn")?.value ?? bot.name,
      title: $("#bt")?.value ?? bot.title,
      description: $("#bd")?.value ?? bot.description,
      instructions: $("#bi")?.value ?? bot.instructions,
      harness: {
        provider: $("#bh")?.value || bot.harness?.provider || "default",
        model: ($("#bm")?.value ?? bot.harness?.model ?? "").trim(),
      },
      notificationsEnabled: bot.notificationsEnabled,
      color: bot.color,
      avatar: defaultAvatar(bot.avatar),
    },
  });
  state.botEdit = false;
  await refresh();
}

async function deleteMessages(ids) {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot || !ids?.length) return;
  const drop = new Set(ids);
  for (const id of ids) forgottenMessages.add(`${bot.id}:${id}`);
  bot.messages = (bot.messages || []).filter((m) => !drop.has(m.id));
  paintChat(bot);
  try {
    const q = ids.length > 1 ? `?ids=${encodeURIComponent(ids.slice(1).join(","))}` : "";
    const next = await api(`/api/bots/${bot.id}/messages/${encodeURIComponent(ids[0])}${q}`, { method: "DELETE" });
    if (Array.isArray(next?.messages)) bot.messages = next.messages.filter((m) => !drop.has(m.id));
    paintChat(bot);
  } catch (err) {
    for (const id of ids) forgottenMessages.delete(`${bot.id}:${id}`);
    window.alert(err?.message || "Could not delete the message.");
    await refresh();
  }
}

async function resetVm() {
  if (!state.selected) return;
  await api(`/api/bots/${state.selected}/vm`, { method: "POST", body: { action: "reset" } });
  liveFrameKey = null;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) mountLiveFrame(bot);
}

function reconnectStream() {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  const wrap = $("#screen-wrap");
  const iframe = wrap?.querySelector("iframe");
  const still = wrap?.querySelector(".screen-still");
  if (still) still.classList.remove("hidden");
  if (iframe && bot.vm?.novncPort) {
    iframe.src = streamUrl(bot);
    if (still) refreshStill(still, bot.id);
  } else if (bot.vm?.novncPort) {
    liveFrameKey = null;
    mountLiveFrame(bot);
  }
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
}

async function rebootVm() {
  if (!state.selected) return;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  bot.vm = { ...(bot.vm || {}), status: "starting", hint: "Rebooting the computer…", error: null };
  paintLivePane(bot);
  attachLiveFrame(bot);
  try {
    const next = await api(`/api/bots/${bot.id}/vm`, { method: "POST", body: { action: "reboot" } });
    adoptBot(next);
    liveFrameKey = null;
    const live = state.bots.find((b) => b.id === bot.id) || next;
    attachLiveFrame(live);
    paintLivePane(live);
  } catch (err) {
    bot.vm = { ...(bot.vm || {}), status: "error", error: err.message };
    paintLivePane(bot);
    window.alert(err.message || "Could not reboot the computer.");
  }
}

async function resumeVm() {
  if (!state.selected) return;
  if (dockerMissing()) {
    await recoverDocker();
    if (dockerMissing()) {
      paintDockerGate();
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        bot.vm = { ...(bot.vm || {}), status: "error", error: state.docker.hint };
        paintLivePane(bot);
      }
      return;
    }
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) {
    bot.vm = { ...(bot.vm || {}), status: "starting", error: null, hint: "Starting the computer…" };
    paintLivePane(bot);
  }
  try {
    await api(`/api/bots/${state.selected}/vm`, { method: "POST", body: { action: "start" } });
    await refresh();
    liveFrameKey = null;
    const live = state.bots.find((b) => b.id === state.selected);
    if (live) mountLiveFrame(live);
  } catch (err) {
    const live = state.bots.find((b) => b.id === state.selected);
    if (live) {
      live.vm = { ...(live.vm || {}), status: "error", error: err.message };
      paintLivePane(live);
    } else {
      window.alert(err.message || "Could not start the computer.");
    }
  }
}

async function refresh() {
  const incoming = await api("/api/bots");
  syncBots(incoming);
  const saved = state.selected || (typeof localStorage !== "undefined" ? localStorage.getItem("selectedBot") : null);
  if (saved && state.bots.some((b) => b.id === saved)) rememberSelected(saved);
  else if (state.bots[0]) rememberSelected(state.bots[0].id);
  render();
  if (state.selected) loadBotHistory(state.selected);
}

async function refreshSettings() {
  const r = await api("/api/settings");
  state.settings = r.settings;
  state.timezone = r.timezone;
  state.hasGrokAuth = Boolean(r.hasGrokAuth);
  if (r.docker) state.docker = r.docker;
  if (r.appVersion) state.appVersion = r.appVersion;
  applyTheme();
  paintDockerGate();
  await loadLocalHarness();
  loadHarnessStatus().catch(() => {});
}

async function loadLocalHarness() {
  try {
    state.localHarness = await api("/api/harness/local");
  } catch {
    state.localHarness = {
      ollama: { ok: false, models: [] },
      lmstudio: { ok: false, models: [] },
      grok: { ok: true, models: grokModels() },
    };
  }
}

function wantsGrokBuild() {
  const p = state.settings?.harness?.provider;
  return p === "grok-build" || !p;
}

function paintGrokAuth() {
  let host = $("#grok-auth-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "grok-auth-host";
    document.body.appendChild(host);
  }
  // null = unknown; never prompt until the server said we are signed out
  const need = wantsGrokBuild() && state.hasGrokAuth === false && state.grokAuthAsk && state.grokAuthAsk !== "later";
  if (!need) {
    host.innerHTML = "";
    return;
  }
  const pending = state.grokAuthAsk === "pending";
  host.innerHTML = `<div class="overlay grok-auth-overlay" data-act="grok-auth-later">
    <div class="modal grok-auth-modal">
      <div class="sbody" style="width:100%">
        <button type="button" class="close" data-act="grok-auth-later" title="Close">${iconClose()}</button>
        <h2>Sign in to Grok</h2>
        <p class="muted">${
          pending
            ? "Finish sign-in in your Mac browser. This sheet closes when Grok is ready."
            : "Grok Build needs a login on this Mac. Sign in once in your browser."
        }</p>
        <div class="routine-editor-foot">
          <button type="button" class="pill" data-act="grok-auth-later">Later</button>
          <button type="button" class="pill primary" data-act="grok-auth-now">${pending ? "Open login again" : "Sign in with Grok"}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function applyTheme() {
  const t = state.settings?.themePreference || "system";
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t === "system" ? "light dark" : t;
}

async function setHumanControl(on) {
  const id = state.selected;
  if (!id) return;
  state.humanControl = on;
  paintControlChrome();
  if (on) {
    await stopTurn();
    reconnectStream();
  }
  try {
    await api(`/api/bots/${id}/control`, { method: "POST", body: { on } });
  } catch {
    /* still local */
  }
  paintControlChrome();
}

function paintControlChrome() {
  const wrap = $("#screen-wrap");
  if (!wrap || wrap.dataset.empty) return;
  let bar = wrap.querySelector(".take-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "take-bar";
    wrap.appendChild(bar);
  }
  bar.innerHTML = state.humanControl
    ? `<button type="button" class="take-ctl on" data-act="release-control">You're driving · Release</button>`
    : `<button type="button" class="take-ctl" data-act="take-control">Take control</button>`;
  wrap.classList.toggle("human", Boolean(state.humanControl));
}

function listen() {
  let es = null;
  let opened = false;
  let retry = 0;
  const attach = () => {
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
    es = new EventSource("/api/events");
    es.addEventListener("bots", (e) => {
      syncBots(JSON.parse(e.data));
      render();
    });
    es.addEventListener("computers", () => {
      loadComputers();
    });
    es.addEventListener("routine", (e) => {
      const { botId, routine } = JSON.parse(e.data);
      if (!routine?.id) return;
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      const rows = Array.isArray(bot.routines) ? bot.routines : [];
      const i = rows.findIndex((r) => r.id === routine.id);
      if (i >= 0) rows[i] = routine;
      else rows.push(routine);
      bot.routines = rows;
      if (botId === state.selected) paintRoutineList(bot);
    });
    es.addEventListener("bot", (e) => {
      const bot = adoptBot(JSON.parse(e.data));
      const selected = state.bots.find((b) => b.id === state.selected);
      if (selected && $("#thread")) {
        paintChat(selected);
        paintRoutineList(selected);
        if (state.botEdit) {
          const host = $("#bot-editor");
          const active = document.activeElement;
          const typing = Boolean(
            host && host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName),
          );
          if (host && !typing) delete host.dataset.bot;
          paintBotEditor(selected);
        }
        syncEditorChips(selected);
        refreshAvatars();
        if (bot.id === selected.id && (state.showComputer || state.deskSize === "full")) attachLiveFrame(selected);
      } else render();
    });
    es.addEventListener("control", (e) => {
      const { botId, on } = JSON.parse(e.data);
      if (botId !== state.selected) return;
      state.humanControl = Boolean(on);
      paintControlChrome();
    });
    es.addEventListener("error", (e) => {
      try {
        const { botId } = JSON.parse(e.data);
        const bot = state.bots.find((b) => b.id === botId);
        if (bot) {
          bot.busy = false;
          if (botId === state.selected && $("#thread")) paintChat(bot);
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("tool", (e) => {
      const { botId, name } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot || name === "send_message") return;
      bot.busy = true;
      if (botId === state.selected && $("#thread")) paintChat(bot);
    });
    es.addEventListener("message", (e) => {
      const { botId, ...msg } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      if (!bot.messages.some((m) => m.id === msg.id)) {
        if (msg.role === "user") {
          bot.messages = bot.messages.filter(
            (m) => !(String(m.id).startsWith("pending-") && m.content === msg.content),
          );
        }
        bot.messages.push(msg);
        if (botId !== state.selected && (msg.role === "assistant" || msg.kind === "tool")) {
          bot.unread = true;
          api(`/api/bots/${botId}`, { method: "PATCH", body: { unread: true } });
        }
      }
      if (botId === state.selected && $("#thread")) {
        paintChat(bot);
        refreshAvatars();
      } else render();
    });
    es.addEventListener("log", (e) => {
      const { botId, m } = JSON.parse(e.data);
      state.logs.push(m);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      const setup = /Setting up the computer \((\d+)\/(\d+)\):\s*(.+)/.exec(m);
      if (setup) {
        bot.vm = {
          ...(bot.vm || {}),
          hint: m,
          status: "starting",
          setup: { step: Number(setup[1]), total: Number(setup[2]), label: setup[3].trim(), ready: false },
        };
      } else if (/Computer is ready/i.test(m)) {
        bot.vm = {
          ...(bot.vm || {}),
          hint: "",
          status: "running",
          setup: { step: 4, total: 4, label: "Ready", ready: true },
        };
      } else {
        const keep = bot.vm?.setup?.ready === false ? false : bot.vm?.status === "running" || bot.vm?.status === "paused";
        bot.vm = { ...(bot.vm || {}), hint: m, status: keep ? bot.vm.status || "running" : "starting" };
      }
      if (botId === state.selected) {
        paintScreenStatus(bot);
        const label = $("#screen-label");
        if (label && bot.vm.status === "starting" && !bot.vm.novncPort) label.textContent = m;
      }
    });
    es.addEventListener("vm-status", (e) => {
      const { botId, status, hint } = JSON.parse(e.data);
      const bot = state.bots.find((b) => b.id === botId);
      if (!bot) return;
      bot.vm = { ...(bot.vm || {}), status: status || bot.vm?.status, hint: hint || bot.vm?.hint };
      if (botId === state.selected) paintScreenStatus(bot);
    });
    es.addEventListener("screen", (e) => {
      const { botId, url } = JSON.parse(e.data);
      if (botId !== state.selected) return;
      const still = $(".screen-still");
      if (!still) return;
      if (url) refreshStill(still, botId);
    });
    es.onerror = () => {
      const label = $("#screen-label");
      /* keep the label as just the bot's screen name */
      if (es && es.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(attach, 1500);
      }
    };
    es.onopen = () => {
      if (!opened) {
        opened = true;
        return;
      }
      refresh().catch(() => {});
    };
  };
  attach();
}

let startingVm = false;
function watchStream() {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot?.id || state.botEdit) return;
  if (!state.showComputer && state.deskSize !== "full") return;
  if (dockerMissing()) {
    attachLiveFrame(bot);
    return;
  }
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
  const vm = bot.vm || {};
  if (needsDesk(bot)) {
    attachLiveFrame(bot);
    return;
  }
  const needsStart = !["running", "starting", "paused", "exited", "stopped"].includes(vm.status || "");
  if (needsStart && !startingVm) {
    startingVm = true;
    resumeVm()
      .catch(() => {})
      .finally(() => {
        startingVm = false;
      });
    return;
  }
  api(`/api/bots/${bot.id}/stream-health`)
    .then((h) => {
      if (h.docker) {
        const was = dockerMissing();
        state.docker = h.docker;
        if (was !== dockerMissing()) attachLiveFrame(bot);
      }
      if (h.ok && $("#screen-wrap iframe")) return;
      if (needsDesk(bot)) {
        attachLiveFrame(bot);
        return;
      }
      if (!h.running && !startingVm && !["paused", "exited", "stopped"].includes(vm.status || "")) {
        startingVm = true;
        resumeVm()
          .catch(() => {})
          .finally(() => {
            startingVm = false;
          });
        return;
      }
      if (bot.vm?.novncPort) scheduleStreamRetry(bot, 400);
    })
    .catch(() => {
      if (needsDesk(bot)) {
        attachLiveFrame(bot);
        return;
      }
      if (!startingVm) {
        startingVm = true;
        resumeVm()
          .catch(() => {})
          .finally(() => {
            startingVm = false;
          });
      }
    });
}

(async function init() {
  await refreshSettings();
  const ev = await runningAppVersion();
  if (ev) state.appVersion = ev;
  await refresh();
  listen();
  render();
  loadComputers().catch(() => {});
  setInterval(() => {
    if (state.modal === "computers") loadComputerStats();
  }, 4000);
  if (window.sub8Desktop?.onPausing) {
    window.sub8Desktop.onPausing(() => {
      state.pausingQuit = true;
      let host = $("#quit-pause");
      if (!host) {
        host = document.createElement("div");
        host.id = "quit-pause";
        document.body.appendChild(host);
      }
      host.innerHTML = `<div class="overlay"><div class="modal" style="height:auto;width:min(400px,90%)"><div class="sbody" style="width:100%"><h2>Pausing computers…</h2><p class="muted">They'll wake when you open Sub8 again.</p></div></div></div>`;
    });
  }
  document.documentElement.dataset.appReady = "1";
  checkForUpdate({ silent: true }).catch(() => {});
  if (wantsGrokBuild()) {
    if (state.hasGrokAuth) {
      state.grokAuthAsk = false;
    } else {
      state.grokAuthAsk = true;
      paintGrokAuth();
    }
    startGrokOAuth();
  }
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot && bot.vm?.container && bot.vm.status !== "running") {
    resumeVm().catch(() => {});
  }
  setInterval(watchStream, 8_000);
  setInterval(() => {
    api("/api/health")
      .then((h) => {
        if (!h?.docker) return;
        const was = dockerMissing();
        state.docker = h.docker;
        if (was === dockerMissing()) {
          if (!was) return;
          paintDockerGate();
          return;
        }
        paintDockerGate();
        if (!dockerMissing()) {
          const bot = state.bots.find((b) => b.id === state.selected);
          if (bot) resumeVm().catch(() => {});
        } else {
          const bot = state.bots.find((b) => b.id === state.selected);
          if (bot) attachLiveFrame(bot);
        }
      })
      .catch(() => {});
  }, 5_000);
  window.addEventListener("focus", () => {
    const bot = state.bots.find((b) => b.id === state.selected);
    if (bot?.vm?.novncPort) scheduleStreamRetry(bot, 700);
  });
})();
