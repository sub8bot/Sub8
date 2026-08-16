import { animList, faceList, syncAvatars } from "./avatar.js";

const COLORS = [
  "#b06dd1",
  "#9b6dd1",
  "#c56dd1",
  "#7d6dd1",
  "#d16db8",
  "#8b6de0",
  "#be7adf",
  "#a56de0",
  "#d17dc9",
  "#9966cc",
  "#c98ae0",
  "#7c6cf0",
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
          <h1>OctoBot catalog</h1>
          <p class="lede">Cute octopus faces and motions. Click a card to preview.</p>
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
