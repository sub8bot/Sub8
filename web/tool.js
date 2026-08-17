import { animList, bodyList, faceList, getLookTune, setLookTune, LOOK_DEFAULTS, syncAvatars } from "./avatar.js";
import { AVATAR_COLORS as COLORS } from "./palette.js";

const SAVE = "sub8bot-catalog";
const state = {
  body: "rounder",
  face: "neutral",
  motion: "idle",
  color: COLORS[0],
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE) || localStorage.getItem("octobot-catalog") || "null");
    if (!saved) return;
    if (saved.body === "mantle") state.body = "rounder";
    else if (bodies.some((b) => b.id === saved.body)) state.body = saved.body;
    if (faces.some((f) => f.id === saved.face)) state.face = saved.face;
    if (motions.some((m) => m.id === saved.motion)) state.motion = saved.motion;
    if (COLORS.includes(saved.color)) state.color = saved.color;
    if (saved.look) {
      const look = { ...saved.look };
      if (look.highlights != null) look.highlights = Math.min(2, Math.max(1, Number(look.highlights) || 1));
      setLookTune(look);
    }
  } catch {
    /* ignore */
  }
}

function saveState() {
  localStorage.setItem(
    SAVE,
    JSON.stringify({
      body: state.body,
      face: state.face,
      motion: state.motion,
      color: state.color,
      look: getLookTune(),
    }),
  );
}

const bodies = bodyList();
const faces = faceList();
const motions = animList();
loadState();

const $ = (sel, el = document) => el.querySelector(sel);

function labelOf(list, id) {
  return list.find((row) => row.id === id)?.label || id;
}

function stage(id, slot, size) {
  return `<div class="stage" data-avatar="${id}" data-avatar-slot="${slot}" data-avatar-size="${size}"></div>`;
}

function mount() {
  $("#app").innerHTML = `
    <div class="page">
      <header class="top">
        <div>
          <h1>Sub8Bot catalog</h1>
          <p class="lede">Bodies, faces, and motions. Click a card to pick.</p>
        </div>
        <div class="count">${bodies.length} bodies · ${faces.length} faces · ${motions.length} motions</div>
      </header>

      <div class="hero">
        ${stage("hero", "hero", 280)}
        <div class="hero-meta" id="hero-meta"></div>
        <div class="swatches">
          ${COLORS.map(
            (hex) =>
              `<button type="button" class="swatch" data-act="color" data-id="${hex}" style="background:${hex}" aria-label="${hex}"></button>`,
          ).join("")}
        </div>
        <div class="look" id="look"></div>
      </div>

      <section>
        <h2>Bodies</h2>
        <div class="grid bodies" id="bodies">
          ${bodies
            .map(
              (b) => `
            <button type="button" class="card" data-act="body" data-id="${b.id}">
              ${stage(b.id, "body", 148)}
              <div class="label">${b.label}</div>
              <div class="sub" data-sub="body"></div>
            </button>`,
            )
            .join("")}
        </div>
      </section>

      <section>
        <h2>Faces</h2>
        <div class="grid" id="faces">
          ${faces
            .map(
              (f) => `
            <button type="button" class="card" data-act="face" data-id="${f.id}">
              ${stage(f.id, "face", 132)}
              <div class="label">${f.label}</div>
              <div class="sub" data-sub="face"></div>
            </button>`,
            )
            .join("")}
        </div>
      </section>

      <section>
        <h2>Motions</h2>
        <div class="grid" id="motions">
          ${motions
            .map(
              (m) => `
            <button type="button" class="card" data-act="motion" data-id="${m.id}">
              ${stage(m.id, "motion", 132)}
              <div class="label">${m.label}</div>
              <div class="sub" data-sub="motion"></div>
            </button>`,
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
  paintLook();
  refresh();
}

const SLIDERS = [
  { key: "gloss", label: "Gloss" },
  { key: "shineSize", label: "Shine size" },
  { key: "shineBlur", label: "Shine blur" },
  { key: "highlights", label: "Highlights", min: 1, max: 2, step: 1, unit: 1 },
  { key: "shineX", label: "Shine X" },
  { key: "shineY", label: "Shine Y" },
  { key: "shine2X", label: "Shine 2 X" },
  { key: "shine2Y", label: "Shine 2 Y" },
  { key: "coat", label: "Coat" },
  { key: "coatSoft", label: "Coat soft" },
  { key: "sheen", label: "Sheen" },
  { key: "ambient", label: "Ambient" },
  { key: "key", label: "Key light" },
  { key: "fill", label: "Fill light" },
  { key: "punch", label: "Color punch" },
];

function paintLook() {
  const look = getLookTune();
  $("#look").innerHTML = SLIDERS.map((s) => {
    const unit = s.unit || 100;
    const min = s.min ?? 0;
    const max = s.max ?? (unit === 1 ? 1 : 100);
    const step = s.step ?? 1;
    const shown = unit === 1 ? look[s.key] : Math.round(look[s.key] * 100);
    const raw = unit === 1 ? look[s.key] : Math.round(look[s.key] * 100);
    return `<label class="slide">
      <span>${s.label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${raw}" data-look="${s.key}" data-unit="${unit}" />
      <em>${shown}</em>
    </label>`;
  }).join("") + `<button type="button" class="look-reset" data-act="look-reset">Reset look</button>`;
}

function refresh() {
  const bodyLabel = labelOf(bodies, state.body);
  const faceLabel = labelOf(faces, state.face);
  const motionLabel = labelOf(motions, state.motion);
  $("#hero-meta").innerHTML = `${bodyLabel} <span>·</span> ${faceLabel} <span>·</span> ${motionLabel}`;

  for (const btn of document.querySelectorAll("[data-act=body]")) {
    btn.classList.toggle("on", btn.dataset.id === state.body);
  }
  for (const btn of document.querySelectorAll("[data-act=face]")) {
    btn.classList.toggle("on", btn.dataset.id === state.face);
  }
  for (const btn of document.querySelectorAll("[data-act=motion]")) {
    btn.classList.toggle("on", btn.dataset.id === state.motion);
  }
  for (const btn of document.querySelectorAll("[data-act=color]")) {
    btn.classList.toggle("on", btn.dataset.id === state.color);
  }
  for (const el of document.querySelectorAll("[data-sub=body]")) el.textContent = `${faceLabel} · ${motionLabel}`;
  for (const el of document.querySelectorAll("[data-sub=face]")) el.textContent = motionLabel;
  for (const el of document.querySelectorAll("[data-sub=motion]")) el.textContent = faceLabel;

  syncAvatars(
    [...document.querySelectorAll("[data-avatar]")].map((el) => {
      const slot = el.dataset.avatarSlot;
      const id = el.dataset.avatar;
      return {
        id,
        el,
        slot,
        size: Number(el.dataset.avatarSize || 104),
        color: state.color,
        framing: "body",
        body: slot === "body" ? id : state.body,
        mood: {
          expression: slot === "face" ? id : state.face,
          animation: slot === "motion" ? id : state.motion,
        },
      };
    }),
  );
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "look-reset") {
    setLookTune(LOOK_DEFAULTS);
    paintLook();
    saveState();
    refresh();
    return;
  }
  if (act === "body") state.body = id;
  if (act === "face") state.face = id;
  if (act === "motion") state.motion = id;
  if (act === "color") state.color = id;
  saveState();
  refresh();
});

document.addEventListener("input", (e) => {
  const el = e.target.closest("[data-look]");
  if (!el) return;
  const key = el.dataset.look;
  const unit = Number(el.dataset.unit || 100);
  const val = unit === 1 ? Number(el.value) : Number(el.value) / 100;
  setLookTune({ [key]: val });
  const em = el.parentElement?.querySelector("em");
  if (em) em.textContent = String(Math.round(val * 100));
  saveState();
});

mount();
