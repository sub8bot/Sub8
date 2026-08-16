import { animList, defaultAvatar, faceList, inferMood, syncAvatars } from "./avatar.js";

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
        bot?.vm?.status === "starting" ? "Starting Grok Bot's computer…" : bot?.vm?.error || "Computer not assigned yet"
      }</div>`;
      liveFrameKey = null;
    }
    return;
  }
  const key = `${bot.id}:${bot.vm.novncPort}`;
  if (liveFrameKey === key && wrap.querySelector("iframe")) return;
  mountLiveFrame(bot);
}

function mountLiveFrame(bot) {
  const wrap = $("#screen-wrap");
  if (!wrap || !bot?.vm?.novncPort) return;
  const key = `${bot.id}:${bot.vm.novncPort}`;
  liveFrameKey = key;
  delete wrap.dataset.empty;
  const t = Date.now();
  wrap.innerHTML = `<img class="screen-still" alt="" src="/api/bots/${bot.id}/screen?t=${t}" /><iframe data-key="${key}" src="http://127.0.0.1:${bot.vm.novncPort}/?autoconnect=1&reconnect=1&resize=scale&t=${t}" allow="clipboard-read; clipboard-write"></iframe>`;
  const iframe = wrap.querySelector("iframe");
  const label = $("#screen-label");
  iframe?.addEventListener("load", () => {
    if (label) label.textContent = `${bot.name}'s screen`;
  });
  iframe?.addEventListener("error", () => {
    if (label) label.textContent = `${bot.name}'s screen`;
  });
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
        batch.push(rows[i]);
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
    const label = thoughts.length > 1 ? `Thought ×${thoughts.length}` : "Thought";
    parts.push(`<details class="thought"${openLast ? " open" : ""}>
      <summary>${label}</summary>
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
  syncEditorChips(bot);
  refreshAvatars();
}

function refreshAvatars() {
  const items = [...document.querySelectorAll("[data-avatar]")].flatMap((el) => {
    const id = el.dataset.avatar;
    const bot = state.bots.find((b) => b.id === id);
    if (!bot && id !== "create") return [];
    const preview = el.dataset.preview === "1";
    const mood =
      id === "create"
        ? defaultAvatar({ expression: state.createFace, animation: "idle" })
        : inferMood(bot, { preview });
    return [
      {
        el,
        id,
        slot: el.dataset.avatarSlot || "default",
        size: Number(el.dataset.avatarSize || 36),
        color: bot?.color,
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

function iconClock() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
}

function paintTitle(bot) {
  const model = state.settings?.harness?.model || "grok-4.6";
  const provider = state.settings?.harness?.provider || "spacexai";
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
            <span class="avatar sm" data-avatar="${bot.id}" data-avatar-slot="title" data-avatar-size="28"></span>
            <span class="bot-label">${escapeHtml(bot.name)}</span>
          </button>`
        : "Local Bot"
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
  const ids = new Set(state.bots.map((b) => b.id));
  for (const node of [...host.children]) {
    if (!ids.has(node.dataset.id)) node.remove();
  }
  for (const b of state.bots) {
    let node = host.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = "rail-bot";
      node.dataset.id = b.id;
      node.innerHTML = `
        <button class="avatar" data-act="select" data-id="${b.id}">
          <span class="avatar-3d" data-avatar="${b.id}" data-avatar-slot="rail" data-avatar-size="38"></span>
        </button>
        <button class="rail-edit" data-act="edit-bot" data-id="${b.id}" title="Edit">✎</button>`;
      host.appendChild(node);
    }
    const btn = node.querySelector(".avatar");
    btn.classList.toggle("active", b.id === bot?.id);
    btn.classList.toggle("busy", Boolean(b.busy || b.vm?.status === "starting"));
    btn.title = b.name;
    node.querySelector(".rail-edit").title = `Edit ${b.name}`;
  }
}

function paintChatPane(bot) {
  const chat = $("#chat");
  if (!bot) {
    chat.innerHTML = `<div class="empty">Create a Bot to get started.</div>`;
    return;
  }
  if (!$("#thread") || !$(".composer-send") || !$(".chat-head") || $(".chat-stop") || document.querySelector("[data-act=picker]")) {
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
          <button type="submit" class="composer-send composer-go" title="Send">${iconMic()}</button>
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

function pickerHtml() {
  return `<div class="picker">
    <input id="pickq" placeholder="Search or create Bots" />
    <div class="pick" data-act="create"><span class="avatar" style="background:#f3f4f6;color:#111">+</span> Create new Bot <span class="kbd">⌘1</span></div>
    ${state.bots
      .map(
        (b) =>
          `<div class="pick ${b.id === state.selected ? "on" : ""}">
            <button class="pick-main" data-act="select" data-id="${b.id}">
              <span class="avatar sm" data-avatar="${b.id}" data-avatar-slot="pick" data-avatar-size="32"></span>
              ${escapeHtml(b.name)}
            </button>
            <button class="pill" data-act="edit-bot" data-id="${b.id}">Edit</button>
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
  const colors = [
    "#ffe566", "#ffd6a5", "#ffb4a2", "#ffc2d4", "#e7c6ff", "#c7ceea",
    "#bde0fe", "#a0e7e5", "#b9fbc0", "#fdffb6", "#f8f4ee", "#e8e4df",
  ];
  const color = bot.color || "#ffe566";
  const avatar = defaultAvatar(bot.avatar);
  host.innerHTML = `
    <div class="avatar-studio">
      <div class="avatar-preview" data-avatar="${bot.id}" data-avatar-slot="editor" data-avatar-size="148" data-preview="1"></div>
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
    <label class="muted">Face</label>
    <div class="chips" id="face-chips">
      ${faceList()
        .map(
          (f) =>
            `<button type="button" class="chip ${f.id === avatar.expression ? "on" : ""}" data-act="avatar-face" data-id="${f.id}">${escapeHtml(f.label)}</button>`
        )
        .join("")}
    </div>
    <label class="muted">Motion</label>
    <div class="chips" id="anim-chips">
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
    <div class="muted" style="margin:0 0 6px">Dark colors flip eyes and mouth to white.</div>
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
            <div class="muted">Every ${mins} minutes${on ? "" : ", paused"}</div>
          </div>
        </div>
        <p class="routine-body">${escapeHtml(r.instruction || "")}</p>
        <div class="routine-actions">
          <button class="pill" data-act="toggle-routine" data-id="${r.id}">${on ? "Pause" : "Resume"}</button>
          <button class="pill" data-act="edit-routine" data-id="${r.id}">Edit</button>
          <button class="pill danger-pill" data-act="delete-routine" data-id="${r.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
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
  if (host.dataset.key === key && host.innerHTML && typing) return;
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
          ${row("Harness", h.provider || "spacexai")}
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
  const groups = ["x-inbox", "email", "flights", "calendar", "files", "general"];
  return `<div class="overlay">
    <div class="modal" style="height:auto;max-height:88%;width:min(520px,92%)" data-modal="1">
      <div class="sbody" style="width:100%">
        <button class="close" data-act="close-modal">×</button>
        <h2>${isNew ? "New routine" : "Edit routine"}</h2>
        <div class="botset">
          <label class="muted">Name</label>
          <input class="field" id="rn" value="${escapeHtml(r?.name || "")}" placeholder="X inbox" />
          <label class="muted">What it should do</label>
          <textarea class="field" id="ri" placeholder="Check notifications and DMs on X">${escapeHtml(r?.instruction || "")}</textarea>
          <label class="muted">Every N minutes</label>
          <input class="field" id="rm" type="number" min="1" value="${mins}" />
          <label class="muted">Group (same group merges overlapping jobs)</label>
          <select class="field" id="rg">
            ${groups
              .map((g) => `<option value="${g}" ${ (r?.groupKey || "general") === g ? "selected" : ""}>${g}</option>`)
              .join("")}
          </select>
          ${isNew ? "" : `<label class="muted"><input type="checkbox" id="re" ${r.enabled !== false ? "checked" : ""}/> Enabled</label>`}
          <button class="pill" data-act="save-routine">${isNew ? "Create" : "Save"}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function botSettingsHtml(bot) {
  return `<aside class="pane" style="background:#fff">
    <div class="section-h"><button class="iconbtn" data-act="bot-settings">‹</button> Settings</div>
    <div class="botset">
      <div style="display:grid;place-items:center;padding:12px 0">${hexIcon(bot.color, letter(bot))}</div>
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
          <div class="avatar-preview sm" data-avatar="create" data-avatar-slot="create" data-avatar-size="108" data-preview="1"></div>
          <label class="muted">Face</label>
          <div class="chips">
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

function harnessHtml(h) {
  return `<h2>Harness</h2>
    <p class="muted" style="margin-top:-8px">Which model stack this app talks to.</p>
    <div class="block">
      <div class="card">
        <div class="row"><div><div class="lbl">Harness</div><div class="sub">Both harnesses drive your computer the Grok Bot way: screenshot, then mouse/keyboard. Grok Build also keeps a resumed grok session on that desktop. Never on this Mac.</div></div>
          <select class="pill" data-harness="provider">
            <option value="spacexai" ${h.provider === "spacexai" || !h.provider ? "selected" : ""}>SpaceXAI (api.x.ai)</option>
            <option value="grok-build" ${h.provider === "grok-build" ? "selected" : ""}>Grok Build (local CLI)</option>
            <option value="custom" ${h.provider === "custom" ? "selected" : ""}>Custom API key / base URL</option>
          </select>
        </div>
        <div class="row"><div class="lbl">Model</div>
          <input class="field" style="max-width:220px" data-harness-text="model" value="${escapeHtml(h.model || "grok-4.6")}" />
        </div>
        <div class="row"><div class="lbl">Base URL</div>
          <input class="field" style="max-width:280px" data-harness-text="baseUrl" value="${escapeHtml(h.baseUrl || "https://api.x.ai/v1")}" />
        </div>
        <div class="row"><div><div class="lbl">API key</div><div class="sub">Leave blank to use XAI_API_KEY from the environment.</div></div>
          <input class="field" style="max-width:220px" type="password" data-harness-text="apiKey" placeholder="••••" />
        </div>
        <div class="row"><div class="lbl">Grok Build command</div>
          <input class="field" style="max-width:220px" data-harness-text="grokBuildCommand" value="${escapeHtml(h.grokBuildCommand || "grok")}" />
        </div>
        ${
          h.provider === "grok-build"
            ? `<div class="row"><div><div class="lbl">Grok Build sign-in</div><div class="sub">One OAuth on this Mac. That session is copied into every computer. No API key.</div></div>
          <button class="pill" data-act="grok-oauth" type="button">Sign in with OAuth</button></div>`
            : ""
        }
        <div class="row"><div><div class="lbl">Connection</div><div class="sub" id="harness-ping">${
          h.provider === "grok-build"
            ? `Grok Build: ${escapeHtml(h.grokBuildCommand || "grok")} inside the VM`
            : h.provider === "custom"
              ? `Custom: ${escapeHtml(h.model || "grok-4.6")} via ${escapeHtml(h.baseUrl || "https://api.x.ai/v1")}`
              : "SpaceXAI default: grok-4.6 via api.x.ai"
        }</div></div>
          <button class="pill" data-act="test-harness" type="button">Test connection</button>
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
        <button class="${sec === "general" ? "active" : ""}" data-act="sec" data-id="general">${iconGear()} General</button>
        <button class="${sec === "harness" ? "active" : ""}" data-act="sec" data-id="harness">⬡ Harness</button>
        <button class="${sec === "usage" ? "active" : ""}" data-act="sec" data-id="usage">▮ Usage & Billing</button>
        <button class="${sec === "updates" ? "active" : ""}" data-act="sec" data-id="updates">↓ Updates</button>
      </nav>
      <div class="sbody">
        <button class="close" data-act="close-modal">×</button>
        ${
          sec === "harness"
            ? harnessHtml(h)
            : sec === "general"
            ? `<h2>General</h2>
          <div class="block"><h3>Account</h3>
            <div class="card row"><div class="acct"><div class="me"></div><div><div class="who">Local Bot</div><div class="mail">signed in on this Mac</div></div></div></div>
          </div>
          <div class="block"><h3>Appearance</h3>
            <div class="card row"><div><div class="lbl">Theme</div></div>
              <select class="pill" data-set="themePreference">
                <option value="system" ${s.themePreference === "system" ? "selected" : ""}>Follow System</option>
                <option value="light" ${s.themePreference === "light" ? "selected" : ""}>Light</option>
                <option value="dark" ${s.themePreference === "dark" ? "selected" : ""}>Dark</option>
              </select>
            </div>
          </div>
          <div class="block"><h3>System</h3>
            <div class="card row"><div><div class="lbl">Use hardware acceleration</div></div>
              <button class="toggle ${s.hardwareAccelerationEnabled ? "on" : ""}" data-tog="hardwareAccelerationEnabled"><i></i></button>
            </div>
          </div>
          <div class="block"><h3>Bot</h3>
            <div class="card">
              <div class="row"><div><div class="lbl">Timezone</div></div>
                <span class="pill">Auto-detect (${state.timezone})</span></div>
              <div class="row"><div><div class="lbl">Execution on Local Computer</div><div class="sub">Let the assistant open files and run tasks on your computer. Auto-review still checks everything first.</div></div>
                <select class="pill" data-set="localExecPermission">
                  <option value="always" ${s.localExecPermission === "always" ? "selected" : ""}>Always allow</option>
                  <option value="ask" ${s.localExecPermission === "ask" ? "selected" : ""}>Ask every time</option>
                  <option value="never" ${s.localExecPermission === "never" ? "selected" : ""}>Never allow</option>
                </select>
              </div>
              <div class="row"><div><div class="lbl">Auto-review</div><div class="sub">Grok Bot checks each action before it runs and asks you first when needed.</div></div>
                <button class="toggle ${s.autoReviewEnabled ? "on" : ""}" data-tog="autoReviewEnabled"><i></i></button>
              </div>
            </div>
          </div>`
            : sec === "usage"
              ? `<h2>Usage</h2><div class="card"><div class="lbl">Included usage</div><div class="muted">Usage follows your SpaceXAI / custom provider plan.</div></div>`
              : `<h2>Updates</h2>
          <div class="block"><h3>Updates</h3>
            <div class="card">
              <div class="row"><div><div class="lbl">Update Track</div><div class="sub">Stable is the safe default.</div></div>
                <select class="pill" data-set="updateTrack">
                  <option value="stable" ${s.updateTrack === "stable" ? "selected" : ""}>stable</option>
                  <option value="nightly" ${s.updateTrack === "nightly" ? "selected" : ""}>nightly</option>
                  <option value="dogfood" ${s.updateTrack === "dogfood" ? "selected" : ""}>dogfood</option>
                </select>
              </div>
              <div class="row"><div><div class="lbl">Version 0.1.0</div><div class="sub">Local Bot · you're on this machine</div></div>
                <button class="pill">Check for Updates</button></div>
            </div>
          </div>
          <div class="block"><h3>Grok Bot's Computer</h3>
            <div class="card">
              <div class="lbl">Update Grok Bot's Computer</div>
              <div class="sub">Updates the computer your assistants share. Your files and logins stay.</div>
              <div class="banner">Your computer is a local Linux VM on this Mac</div>
              <div class="row"><div><div class="lbl">Reset Grok Bot's Computer</div><div class="sub">Start fresh if the computer gets stuck.</div></div>
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
  document.addEventListener("click", (e) => {
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
    if (act === "avatar-face" || act === "avatar-anim") {
      const bot = state.bots.find((b) => b.id === state.selected);
      if (bot) {
        bot.avatar = defaultAvatar({
          ...(bot.avatar || {}),
          [act === "avatar-face" ? "expression" : "animation"]: el.dataset.id,
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
    if (act === "reset-vm") resetVm();
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
    if (act === "save-routine") {
      saveRoutine();
      return;
    }
    if (act === "send") $("#send")?.dispatchEvent(new Event("submit"));
    if (act === "test-harness") {
      testHarness();
      return;
    }
    if (act === "grok-oauth") {
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
    if (r.needHostLogin) {
      const end = Date.now() + 180_000;
      const poll = async () => {
        if (Date.now() > end) return;
        try {
          const again = await api("/api/harness/grok-login", { method: "POST", body: { botId: state.selected } });
          if (again.reused && note) {
            note.textContent = again.message || "Signed in.";
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
    group_key: $("#rg")?.value || "general",
  };
  if (!body.instruction.trim()) return;
  if (state.editingRoutineId) {
    body.enabled = Boolean($("#re")?.checked);
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
      refresh()
        .then(() => {
          liveFrameKey = null;
          const bot = state.bots.find((b) => b.id === state.selected);
          if (bot) mountLiveFrame(bot);
        })
        .catch(() => {});
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
      liveFrameKey = null;
      if (bot.vm?.novncPort) mountLiveFrame(bot);
      else if (!startingVm && vm.status !== "starting") {
        startingVm = true;
        resumeVm()
          .catch(() => {})
          .finally(() => {
            startingVm = false;
          });
      }
    })
    .catch(() => {
      liveFrameKey = null;
      if (bot.vm?.novncPort) mountLiveFrame(bot);
    });
}

(async function init() {
  await refreshSettings();
  await refresh();
  listen();
  render();
  document.documentElement.dataset.appReady = "1";
  const bot = state.bots.find((b) => b.id === state.selected);
  if (bot && bot.vm?.container && bot.vm.status !== "running") {
    resumeVm().catch(() => {});
  }
  setInterval(watchStream, 8_000);
})();
