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
  paneWidth: Number(localStorage.getItem("paneWidth")) || 420,
  plusMenu: false,
  humanControl: false,
  railWake: null,
  ctx: null,
  hasGrokAuth: null,
  grokAuthAsk: false,
  teach: null,
  teachFrames: [],
  attachments: [],
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

function attachLiveFrame(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap) return;
  if (!bot?.vm?.novncPort) {
    if (!wrap.dataset.empty) {
      wrap.dataset.empty = "1";
      wrap.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#6b7280;font-size:13px;padding:16px;text-align:center">${
        bot?.vm?.status === "starting" ? "Starting Sub8Bot's computer…" : bot?.vm?.error || "Computer not assigned yet"
      }</div>`;
      liveFrameKey = null;
    }
    return;
  }
  const key = `${bot.id}:${bot.vm.novncPort}`;
  if (liveFrameKey === key && wrap.querySelector("iframe")) return;
  mountLiveFrame(bot);
}

function streamUrl(bot) {
  const t = Date.now();
  return `http://127.0.0.1:${bot.vm.novncPort}/?autoconnect=1&reconnect=1&reconnect_delay=1500&resize=scale&t=${t}`;
}

function mountLiveFrame(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap || !bot?.vm?.novncPort) return;
  const key = `${bot.id}:${bot.vm.novncPort}`;
  liveFrameKey = key;
  delete wrap.dataset.empty;
  const t = Date.now();
  wrap.innerHTML = `<img class="screen-still" alt="" src="/api/bots/${bot.id}/screen?t=${t}" /><iframe data-key="${key}" src="${streamUrl(bot)}" allow="clipboard-read; clipboard-write"></iframe>`;
  const iframe = wrap.querySelector("iframe");
  const still = wrap.querySelector(".screen-still");
  const label = $("#screen-label");
  iframe?.addEventListener("load", () => {
    if (label) label.textContent = `${bot.name}'s screen`;
    setTimeout(() => {
      if (still?.parentNode === wrap) still.classList.add("hidden");
    }, 1400);
  });
  iframe?.addEventListener("error", () => scheduleStreamRetry(bot, 1600));
  // Selkies drops the previous viewer when a new one attaches. Kick once after open.
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

function adoptBot(next) {
  if (!next?.id) return next;
  const i = state.bots.findIndex((b) => b.id === next.id);
  if (i < 0) {
    next.messages = Array.isArray(next.messages) ? next.messages : [];
    state.bots.push(next);
    return next;
  }
  const prev = state.bots[i];
  next.messages = unionClientMessages(next.messages, prev.messages);
  state.bots[i] = { ...prev, ...next, messages: next.messages };
  return state.bots[i];
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
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const rows = bot.messages.filter((m) => !m.hidden && m.role !== "tool");
  if (!rows.length && !bot.busy) {
    thread.innerHTML = `<div class="empty">Message ${escapeHtml(bot.name)} to put it to work.</div>`;
    return;
  }
  const html = [];
  for (let i = 0; i < rows.length; ) {
    const m = rows[i];
    if (m.role === "user") {
      html.push(`<div class="bubble user">${escapeHtml(m.content)}</div>`);
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
    html.push(`<div class="bubble">${formatChatText(m.content)}</div>`);
    i += 1;
  }
  if (bot.busy) {
    html.push(`<div class="working"><span class="working-dot"></span>Working…</div>`);
  }
  thread.innerHTML = html.join("");
  if (nearBottom || bot.busy) thread.scrollTop = thread.scrollHeight;
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
  return `<div class="tool-list">${parts.join("")}</div>`;
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
  bindSplit();
}

function applyPaneWidth() {
  const frame = $("#shell-root");
  if (!frame) return;
  const w = Math.round(state.paneWidth || 420);
  frame.style.setProperty("--pane-w", `${w}px`);
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

function paintTitle(bot) {
  const model = state.settings?.harness?.model || "grok-4.6";
  const provider = state.settings?.harness?.provider || "grok-build";
  const bar = $("#titlebar");
  const collapsed = !state.showComputer && !state.botEdit && state.deskSize !== "full";
  const stamp = `${bot?.id || ""}|${state.botEdit ? "1" : "0"}|${state.deskSize}|${collapsed ? "1" : "0"}`;
  if (bar.dataset.stamp === stamp && bar.querySelector(".botname-btn")) {
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
        : "Sub8Bot"
    }
      <span class="muted harness-chip">${escapeHtml(provider)} · ${escapeHtml(model)}</span>
    </div>
    <div class="spacer"></div>
    <div class="title-actions">
      ${
        !bot
          ? ""
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
  if (!rail.dataset.ready) {
    rail.innerHTML = `
      <button class="plus" data-act="create" title="Create new Bot">+</button>
      <div class="rail-bots" id="rail-bots"></div>
      <div class="grow"></div>
      <button class="me" data-act="profile" title="App settings"></button>`;
    rail.dataset.ready = "1";
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

function sectionTag(id, name) {
  const tag = document.createElement("div");
  tag.className = "rail-sec";
  tag.dataset.sec = id || "";
  tag.title = name;
  tag.innerHTML = `<span>${escapeHtml(name)}</span>`;
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
  if (!$("#thread") || !$(".composer-mic") || !$(".chat-head") || $(".chat-stop") || document.querySelector("[data-act=picker]")) {
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
          <input name="q" placeholder="Message ${escapeHtml(bot.name)}" autocomplete="off" />
          <button type="button" class="composer-send composer-stop" data-act="stop-turn" hidden title="Stop">${iconStop()}</button>
          <button type="button" class="composer-mic" data-act="dictate" title="Speak">${iconMic()}</button>
          <button type="submit" class="composer-send composer-go" title="Send">${iconSend()}</button>
        </form>
        <input id="attach-file" type="file" multiple hidden />
      </div>
      <div id="picker-host"></div>`;
    $("#send").addEventListener("submit", onSend);
    $("#attach-file")?.addEventListener("change", onAttachFiles);
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
      <button class="open-desk" data-act="open-desk" type="button">${iconExpand()} Open</button>
      <div class="screen-label" id="screen-label"></div>
      <div class="section-h">Routines <button class="iconbtn add-routine" data-act="add-routine" type="button" title="Add routine">+</button></div>
      <div id="routine-list"></div>
      <p class="error" id="vm-error"></p>
    </div>
    <div id="bot-editor" class="bot-editor" hidden></div>`;
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
  if (label && bot) label.textContent = `${bot.name}'s screen`;
  const err = $("#vm-error");
  if (err) err.textContent = bot?.vm?.error || "";
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
      const mins = Math.max(1, Math.round((r.intervalMs || 0) / 60000));
      const on = r.enabled !== false;
      return `<div class="routine-card ${on ? "" : "off"}">
        <div class="routine-top">
          <span class="routine-clock">${iconClock()}</span>
          <div class="routine-copy">
            <b>${escapeHtml(r.name || "Routine")}</b>
            <div class="muted">Every ${mins} minutes${on ? "" : ", paused"}${r.lastRunAt ? ` · last ${fmtWhen(r.lastRunAt)}` : ""}</div>
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

function fmtWhen(ts) {
  const n = Number(ts);
  if (!n) return "—";
  const d = new Date(n);
  const now = Date.now();
  const ago = Math.max(0, now - n);
  if (ago < 60_000) return "just now";
  if (ago < 3600_000) return `${Math.round(ago / 60_000)} min ago`;
  if (ago < 86400_000) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  const key = `${state.modal || ""}|${state.section}|${state.editingRoutineId || ""}|${state.selected || ""}`;
  if (!state.modal) {
    host.innerHTML = "";
    delete host.dataset.key;
    return;
  }
  const active = document.activeElement;
  const typing = host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || "");
  if (host.dataset.key === key && host.innerHTML && (typing || state.modal === "routine")) return;
  host.dataset.key = key;
  if (state.modal === "create") host.innerHTML = createBotHtml();
  else if (state.modal === "settings") host.innerHTML = settingsHtml();
  else if (state.modal === "advanced" && bot) host.innerHTML = advancedHtml(bot);
  else if (state.modal === "routine" && bot) {
    host.innerHTML = routineEditorHtml(bot);
  } else host.innerHTML = "";
}

function advancedHtml(bot) {
  const h = state.settings?.harness || {};
  const s = bot.storage || {};
  const msgs = bot.messages || [];
  const visible = msgs.filter((m) => !m.hidden && m.role !== "tool");
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
          ${row("Grok Build session", bot.grokSessionId || bot.id)}
          ${row("Bot", bot.name)}
          ${row("Model", h.model || "grok-4.6")}
          ${row("Harness", h.provider || "grok-build")}
          ${row("API base", h.baseUrl || "https://api.x.ai/v1")}
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
            <span class="muted">Every</span>
            <div class="routine-mins">
              <input class="field" id="rm" type="number" min="1" value="${mins}" />
              <span class="muted">minutes</span>
            </div>
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
              ? `<ul>${runs.map((x) => `<li>${escapeHtml(fmtWhen(x.ts))}</li>`).join("")}</ul>`
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

function createBotHtml() {
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(440px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>Create new Bot</h2>
        <div class="botset">
          <div class="avatar-preview sm" data-avatar="create" data-avatar-slot="create" data-avatar-size="128" data-avatar-framing="body" data-preview="1"></div>
          <label class="muted">Face</label>
          <div class="chips chips-scroll">
            ${faceList()
              .map(
                (f) =>
                  `<button type="button" class="chip ${f.id === state.createFace ? "on" : ""}" data-act="create-face" data-id="${f.id}">${escapeHtml(f.label)}</button>`
              )
              .join("")}
          </div>
          <label class="muted">Name</label>
          <input class="field" id="cn" placeholder="New Bot" autofocus />
          <label class="muted">What this Bot is for</label>
          <textarea class="field" id="cd" placeholder="Describe the job"></textarea>
          <button class="pill primary" data-act="confirm-create">Create Bot</button>
        </div>
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

function harnessHtml(h) {
  const grok = h.provider !== "spacexai" && h.provider !== "custom";
  return `<h2>Harness</h2>
    <p class="muted" style="margin-top:-8px">How every Bot talks to a model.</p>
    <div class="block">
      <div class="card">
        <div class="row"><div><div class="lbl">Provider</div><div class="sub">Grok Build is the default (OAuth on this Mac). SpaceXAI uses an API key.</div></div>
          <div class="seg" role="tablist">
            <button type="button" class="seg-btn ${grok ? "on" : ""}" data-act="set-harness" data-id="grok-build">Grok Build</button>
            <button type="button" class="seg-btn ${h.provider === "spacexai" ? "on" : ""}" data-act="set-harness" data-id="spacexai">SpaceXAI</button>
          </div>
        </div>
        <div class="row"><div class="lbl">Model</div>
          <input class="field" style="max-width:220px" data-harness-text="model" value="${escapeHtml(h.model || "grok-4.6")}" />
        </div>
        ${
          grok
            ? ""
            : `<div class="row"><div><div class="lbl">API key</div><div class="sub">Leave blank to use XAI_API_KEY from the environment.</div></div>
          <input class="field" style="max-width:220px" type="password" data-harness-text="apiKey" placeholder="••••" /></div>`
        }
        <div class="row"><div><div class="lbl">Connection</div><div class="sub" id="harness-ping">${
          grok ? "Grok Build uses this Mac’s Grok login automatically." : "SpaceXAI · api.x.ai"
        }</div></div>
          <button class="pill" data-act="test-harness" type="button">Test</button>
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
              <div class="row"><div class="lbl">Version</div><span class="muted">Sub8Bot 0.3.0</span></div>
            </div>
          </div>`
            : sec === "usage"
              ? `<h2>Usage</h2><div class="card"><div class="lbl">Plan</div><div class="muted">Usage follows your Grok Build or xAI account. Nothing is billed inside Sub8Bot.</div></div>`
              : `<h2>Computer</h2>
          <div class="block">
            <div class="card">
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
    const rail = e.target.closest(".rail-bot");
    if (!rail) return;
    e.preventDefault();
    state.ctx = { botId: rail.dataset.id, x: e.clientX, y: e.clientY, sub: null, naming: false };
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
      state.modal = null;
      state.botEdit = false;
      state.editingRoutineId = null;
      render();
      return;
    }
    const el = e.target.closest("[data-act]");
    // Overlay carries data-act only as a fallback; inner modal clicks must not inherit it.
    if (!el || el.classList.contains("overlay")) return;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") {
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
    if (act === "close-modal") {
      state.modal = null;
      state.botEdit = false;
      state.editingRoutineId = null;
    }
    if (act === "sec") state.section = el.dataset.id;
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
      state.modal = "create";
      state.picker = false;
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
      const id = el.dataset.id;
      if (state.confirmDeleteId === id) {
        deleteBot(id);
        return;
      }
      state.confirmDeleteId = id;
      render();
      return;
    }
    if (act === "reset-vm") {
      if (confirm("Reset this Bot’s computer? Files and logins on that desktop will be gone.")) resetVm();
      return;
    }
    if (act === "reload-vm") {
      resumeVm();
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
    }
    if (act === "edit-routine") {
      state.modal = "routine";
      state.editingRoutineId = el.dataset.id;
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
      if (state.ctx) state.ctx = { ...state.ctx, naming: true, sub: "move" };
      paintCtxMenu();
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
      if (id && confirm("Delete this Bot and its computer?")) deleteBot(id);
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
    if (act === "set-harness") {
      const provider = el.dataset.id;
      const harness = { ...(state.settings?.harness || {}), provider };
      if (provider === "spacexai") {
        harness.baseUrl = "https://api.x.ai/v1";
        harness.apiKeyEnv = "XAI_API_KEY";
      }
      state.settings = { ...(state.settings || {}), harness };
      paintModal();
      api("/api/settings", { method: "PUT", body: { harness } }).then(async () => {
        await refreshSettings();
        paintModal();
        render();
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
    if (act === "test-harness") {
      testHarness();
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

async function testHarness() {
  const note = $("#harness-ping");
  if (note) note.textContent = "Testing harness…";
  try {
    const r = await api("/api/harness/test", { method: "POST", body: {} });
    const line = r.ok
      ? `OK · ${r.provider} · ${r.model} · ${r.sample || "PONG"}`
      : `Failed · ${r.error || r.sample || "no reply"}`;
    if (note) note.textContent = line;
  } catch (err) {
    if (note) note.textContent = `Failed · ${err.message}`;
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
    setMicUI(false, "Allow Microphone for Sub8Bot in System Settings → Privacy.");
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

async function onSend(e) {
  e.preventDefault();
  const input = e.target.q;
  const text = input.value.trim();
  const files = state.attachments;
  if ((!text && !files.length) || !state.selected) return;
  input.value = "";
  state.draft = "";
  state.attachments = [];
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
  state.modal = "create";
  state.picker = false;
  render();
}

async function confirmCreateBot() {
  const name = ($("#cn")?.value || "").trim() || "New Bot";
  const description = ($("#cd")?.value || "").trim();
  const bot = await api("/api/bots", {
    method: "POST",
    body: { name, description, avatar: defaultAvatar({ expression: state.createFace, animation: "idle" }) },
  });
  state.createFace = "neutral";
  rememberSelected(bot.id);
  state.modal = null;
  state.picker = false;
  await refresh();
}

async function saveRoutine() {
  const bot = state.bots.find((b) => b.id === state.selected);
  if (!bot) return;
  const body = {
    name: $("#rn")?.value || "Routine",
    instruction: $("#ri")?.value || "",
    interval_minutes: Number($("#rm")?.value || 15),
  };
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

  await api(`/api/bots/${bot.id}/routines/${id}`, { method: "DELETE" });
  if (state.editingRoutineId === id) {
    state.editingRoutineId = null;
    state.modal = null;
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

async function deleteBot(id) {
  if (!id) return;
  await api(`/api/bots/${id}`, { method: "DELETE" });
  state.confirmDeleteId = null;
  state.botEdit = false;
  if (state.selected === id) rememberSelected(null);
  await refresh();
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
      notificationsEnabled: bot.notificationsEnabled,
      color: bot.color,
      avatar: defaultAvatar(bot.avatar),
    },
  });
  state.botEdit = false;
  await refresh();
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
  liveFrameKey = null;
  if (bot.vm?.novncPort) mountLiveFrame(bot);
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
}

async function resumeVm() {
  if (!state.selected) return;
  await api(`/api/bots/${state.selected}/vm`, { method: "POST", body: { action: "start" } });
  await refresh();
  liveFrameKey = null;
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot) mountLiveFrame(bot);
}

async function refresh() {
  const incoming = await api("/api/bots");
  for (const b of incoming) adoptBot(b);
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
  applyTheme();
}

function wantsGrokBuild() {
  const p = state.settings?.harness?.provider;
  return p !== "spacexai" && p !== "custom";
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
            : "Grok Build needs a login on this Mac. Sign in once in your browser — that session is copied into every Bot computer."
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
    state.teach = state.teach === "recording" ? state.teach : state.teach;
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
      const incoming = JSON.parse(e.data);
      for (const b of incoming) adoptBot(b);
      render();
    });
    es.addEventListener("bot", (e) => {
      const bot = adoptBot(JSON.parse(e.data));
      const selected = state.bots.find((b) => b.id === state.selected);
      if (selected && $("#thread")) {
        paintChat(selected);
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
      } else render();
    });
    es.addEventListener("control", (e) => {
      const { botId, on } = JSON.parse(e.data);
      if (botId !== state.selected) return;
      state.humanControl = Boolean(on);
      paintControlChrome();
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
      const { m } = JSON.parse(e.data);
      state.logs.push(m);
    });
    es.addEventListener("screen", (e) => {
      const { botId, url } = JSON.parse(e.data);
      if (botId !== state.selected) return;
      const still = $(".screen-still");
      if (still && url) still.src = url;
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
  const label = $("#screen-label");
  if (label) label.textContent = `${bot.name}'s screen`;
  const vm = bot.vm || {};
  const needsStart = vm.status !== "running" && vm.status !== "starting";
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
      if (h.ok && $("#screen-wrap iframe")) return;
      if (!h.running && !startingVm) {
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
  await refresh();
  listen();
  render();
  document.documentElement.dataset.appReady = "1";
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
  window.addEventListener("focus", () => {
    const bot = state.bots.find((b) => b.id === state.selected);
    if (bot?.vm?.novncPort) scheduleStreamRetry(bot, 700);
  });
})();
