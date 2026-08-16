import { animList, faceList, syncAvatars } from "./avatar.js";

const COLORS = [
  "#ffe566",
  "#ffd6a5",
  "#ffb4a2",
  "#ffc2d4",
  "#e7c6ff",
  "#c7ceea",
  "#bde0fe",
  "#a0e7e5",
  "#b9fbc0",
  "#fdffb6",
  "#f8f4ee",
  "#e8e4df",
];

const state = {
  face: "neutral",
  motion: "idle",
  color: COLORS[0],
};

const faces = faceList();
const motions = animList();

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
          <h1>Grok Bot catalog</h1>
          <p class="lede">Faces and motions. Click a card to preview.</p>
        </div>
        <div class="count">${faces.length} faces · ${motions.length} motions</div>
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
      </div>

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
  refresh();
}

function refresh() {
  const faceLabel = labelOf(faces, state.face);
  const motionLabel = labelOf(motions, state.motion);
  $("#hero-meta").innerHTML = `${faceLabel} <span>·</span> ${motionLabel}`;

  for (const btn of document.querySelectorAll("[data-act=face]")) {
    btn.classList.toggle("on", btn.dataset.id === state.face);
  }
  for (const btn of document.querySelectorAll("[data-act=motion]")) {
    btn.classList.toggle("on", btn.dataset.id === state.motion);
  }
  for (const btn of document.querySelectorAll("[data-act=color]")) {
    btn.classList.toggle("on", btn.dataset.id === state.color);
  }
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
        body: "smooth",
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
  if (act === "face") state.face = id;
  if (act === "motion") state.motion = id;
  if (act === "color") state.color = id;
  refresh();
});

mount();
