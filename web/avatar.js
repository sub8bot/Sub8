import * as THREE from "three";
import { ANIMATIONS, BODIES, EXPRESSIONS, GrokBot } from "./grok-bot.js";

export { ANIMATIONS, BODIES, EXPRESSIONS };

export const LOOK_DEFAULTS = {
  gloss: 1,
  coat: 0.02,
  coatSoft: 1,
  shineSize: 0.28,
  shineBlur: 0.5,
  highlights: 2,
  shineX: 1,
  shineY: 0.76,
  shine2X: 0,
  shine2Y: 0.59,
  sheen: 0.26,
  ambient: 1,
  key: 0.43,
  fill: 1,
  punch: 0.13,
};

let lookTune = { ...LOOK_DEFAULTS };
try {
  const saved = JSON.parse(
    localStorage.getItem("sub8bot-catalog") || localStorage.getItem("octobot-catalog") || "null",
  );
  if (saved?.look && typeof saved.look === "object") {
    lookTune = { ...LOOK_DEFAULTS, ...saved.look };
    lookTune.highlights = Math.min(2, Math.max(1, Number(lookTune.highlights) || 1));
  }
} catch {
  /* ignore */
}

export function getLookTune() {
  return { ...lookTune };
}

export function setLookTune(partial) {
  lookTune = { ...lookTune, ...partial };
  for (const view of views.values()) {
    if (view.color) applyBodyLook(view.bot, lookForColor(view.color));
    applyLookToView(view);
  }
}

function applyLookToView(view) {
  applyMaterialTune(view.bot);
  if (view.lights) {
    if (view.lights.ambient) view.lights.ambient.intensity = lookTune.ambient;
    if (view.lights.hemi) view.lights.hemi.intensity = Math.max(0.35, lookTune.ambient + 0.25);
    if (view.lights.fill) view.lights.fill.intensity = lookTune.fill;
    if (view.lights.shine) {
      placeShinePoint(view.lights.shine, lookTune.shineX, lookTune.shineY, lookTune.key);
    }
    if (view.lights.shine2) {
      const on = lookTune.highlights >= 2;
      placeShinePoint(view.lights.shine2, lookTune.shine2X, lookTune.shine2Y, on ? lookTune.key * 0.7 : 0);
    }
  }
}

function applyMaterialTune(bot) {
  const m = bot?.bodyMaterial;
  if (!m) return;
  const blur = lookTune.shineBlur;
  const dual = lookTune.highlights >= 2;
  if ("roughness" in m) m.roughness = 0.1 + blur * 0.62;
  if ("clearcoat" in m) m.clearcoat = dual ? lookTune.coat : Math.min(lookTune.coat, 0.08);
  if ("clearcoatRoughness" in m) m.clearcoatRoughness = 0.08 + blur * 0.78 + lookTune.coatSoft * 0.08;
  if ("sheen" in m) m.sheen = lookTune.sheen;
}

function makeShinePoint(scene) {
  const light = new THREE.PointLight(0xfff6ee, 0, 16, 1.35);
  scene.add(light);
  return light;
}

function placeShinePoint(light, nx, ny, strength) {
  const dist = 3.35 - lookTune.shineSize * 1.85;
  const x = (nx - 0.5) * 2.8;
  const y = -0.05 + ny * 2.25;
  const z = Math.sqrt(Math.max(0.55, dist * dist - x * x * 0.35 - y * y * 0.2));
  light.position.set(x, y, z);
  light.intensity = Math.max(0, strength) * dist * dist * (0.16 + lookTune.gloss * 0.18);
  light.distance = 16;
}

const views = new Map();
let renderer = null;
let last = performance.now();
let looping = false;
let lastPx = 0;

const REACT_MS = 28_000;
const DONE_MS = 9_000;

const RE = {
  scream: /\b(scream|aaah+|nooo+|help)\b/i,
  rage: /\b(rage|furious|i'?m fuming)\b/i,
  angry: /\b(angry|pissed|wtf|damn it|goddamn)\b/i,
  hot: /\b(so hot|i'?m boiling|sweating|on fire)\b/i,
  cold: /\b(so cold|freezing|i'?m freezing|chilly|brr+)\b/i,
  frustrated:
    /\b(ugh+|argh+|frustrated|frustrating|annoying|this (sucks|is broken)|still broken|why (isn'?t|won'?t|can'?t)|i('m| am) (so )?(tired|done|fed up)|hate this|come on|seriously\??|fix (it|this)|doesn'?t work)\b/i,
  cry: /\b(cry(ing)?|tears|sobbing|heartbroken)\b/i,
  sad: /\b(sad|upset|disappointed|sorry|depressed|miserable)\b/i,
  pleading: /\b(please+|i'?m begging|pretty please)\b/i,
  confused: /\b(confused|huh\??|i don'?t (get|understand)|wait what|how (do|does|come)|what does that)\b/i,
  think: /\b(hmm+|let me think|not sure|maybe)\b/i,
  love: /\b(love (you|this|it)|you'?re the best|thank(s| you)|awesome job|perfect)\b/i,
  kiss: /\b(kiss|xoxo|mwah)\b/i,
  joy: /\b(lmao|rofl|i'?m dying|can'?t stop laughing)\b/i,
  happy: /\b(yay+|woo+|nice|great|awesome|amazing|lol|haha|hehe|good (job|work))\b/i,
  star: /\b(mind blown|unreal|legendary|goat)\b/i,
  wow: /\b(whoa+|wow+|omg|no way|incredible)\b/i,
  yawn: /\b(yawn|so boring)\b/i,
  sleepy: /\b(tired|sleepy|good night|zzz+|bored)\b/i,
  dizzy: /\b(dizzy|woozy|i'?m lost)\b/i,
  sick: /\b(nauseous|i feel sick|gonna throw up)\b/i,
};

export function defaultAvatar(partial = {}) {
  const expression = EXPRESSIONS[partial.expression] ? partial.expression : "neutral";
  const animation = ANIMATIONS[partial.animation] ? partial.animation : "idle";
  const body = BODIES[partial.body] ? partial.body : "rounder";
  return { expression, animation, body };
}

export function inferMood(bot, { preview } = {}) {
  const avatar = defaultAvatar(bot?.avatar);
  if (preview) return avatar;

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const now = Date.now();
  const msgs = bot?.messages || [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !m.hidden);
  const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant" && !m.hidden);
  const lastTool = [...msgs].reverse().find((m) => m.role === "tool" || m.role === "function");
  const text = lastUser?.content || "";
  const userAge = lastUser ? now - (lastUser.ts || 0) : Infinity;
  const asstAge = lastAsst ? now - (lastAsst.ts || 0) : Infinity;

  if (bot?.vm?.status === "error" || bot?.vm?.error) {
    return pack("scared", reduce ? "none" : "shake");
  }

  if (lastUser && userAge < REACT_MS) {
    if (RE.scream.test(text)) return pack("scream", reduce ? "none" : "shake");
    if (RE.rage.test(text)) return pack("rage", reduce ? "none" : "shake");
    if (RE.angry.test(text)) return pack("angry", reduce ? "none" : "shake");
    if (RE.hot.test(text)) return pack("hot", reduce ? "none" : "shiver");
    if (RE.cold.test(text)) return pack("cold", reduce ? "none" : "shiver");
    if (RE.frustrated.test(text)) return pack("steam", reduce ? "none" : "nod");
    if (RE.cry.test(text)) return pack("cry", reduce ? "none" : "idle");
    if (RE.sad.test(text)) return pack("sad", reduce ? "none" : "idle");
    if (RE.pleading.test(text)) return pack("pleading", reduce ? "none" : "sway");
    if (RE.confused.test(text)) return pack("confused", reduce ? "none" : "look");
    if (RE.think.test(text)) return pack("think", reduce ? "none" : "peek");
    if (RE.love.test(text)) return pack("love", reduce ? "none" : "pulse");
    if (RE.kiss.test(text)) return pack("kiss", reduce ? "none" : "idle");
    if (RE.joy.test(text)) return pack("joy", reduce ? "none" : "cheer");
    if (RE.star.test(text)) return pack("star", reduce ? "none" : "excited");
    if (RE.wow.test(text)) return pack("wow", reduce ? "none" : "excited");
    if (RE.yawn.test(text)) return pack("yawn", reduce ? "none" : "stretch");
    if (RE.sleepy.test(text)) return pack("sleepy", reduce ? "none" : "sleep");
    if (RE.dizzy.test(text)) return pack("dizzy", reduce ? "none" : "wiggle");
    if (RE.sick.test(text)) return pack("nauseous", reduce ? "none" : "shiver");
    if (RE.happy.test(text)) return pack("happy", reduce ? "none" : "bounce");
  }

  if (bot?.busy || bot?.vm?.status === "starting") {
    if (bot?.id) idleMoodByBot.delete(bot.id);
    const usingDesk = Boolean(lastTool && (!lastAsst || (lastTool.ts || 0) >= (lastAsst.ts || 0) - 2000));
    return pack(avatar.expression, reduce ? "none" : usingDesk ? "look" : "talk");
  }

  if (lastAsst && asstAge < DONE_MS && userAge < DONE_MS + 4000) {
    if (bot?.id) idleMoodByBot.delete(bot.id);
    return pack(avatar.expression === "neutral" ? "happy" : avatar.expression, reduce ? "none" : "nod");
  }

  const quietFor = Math.min(userAge, asstAge);
  if (quietFor > 12 * 60_000) return idleMoodFor(bot?.id, reduce);
  if (quietFor > 6 * 60_000) return pack(avatar.expression, reduce ? "none" : "idle");

  return pack(avatar.expression, reduce ? "none" : avatar.animation || "idle");
}

function idleMoodFor(botId, reduce) {
  const key = botId || "unknown";
  const cached = idleMoodByBot.get(key);
  if (cached) return cached;
  const faces = IDLE_FACES.filter((id) => EXPRESSIONS[id]);
  const anims = reduce ? ["none"] : IDLE_ANIMS.filter((id) => ANIMATIONS[id]);
  const mood = pack(
    faces[Math.floor(Math.random() * faces.length)] || "happy",
    anims[Math.floor(Math.random() * anims.length)] || "idle",
  );
  idleMoodByBot.set(key, mood);
  return mood;
}

function pack(expression, animation) {
  return defaultAvatar({ expression, animation });
}

export function syncAvatars(items) {
  const seen = new Set();
  let max = 40;
  for (const item of items) {
    const key = `${item.id}:${item.slot || "default"}`;
    seen.add(key);
    max = Math.max(max, item.size || 36);
    let view = views.get(key);
    if (!view || view.el !== item.el || !item.el.isConnected) {
      if (view) disposeView(view);
      view = createView(item);
      views.set(key, view);
    }
    applyView(view, item);
  }
  for (const [key, view] of views) {
    if (!seen.has(key)) {
      disposeView(view);
      views.delete(key);
    }
  }
  ensureRenderer(max);
  if (!looping) {
    looping = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }
}

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0";
  document.body.appendChild(renderer.domElement);
}

function createView(item) {
  const scene = new THREE.Scene();
  const ambient = new THREE.AmbientLight(0xffffff, lookTune.ambient);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xe8d8cc, Math.max(0.35, lookTune.ambient + 0.25));
  const fill = new THREE.DirectionalLight(0xeef2ff, lookTune.fill);
  fill.position.set(-2.2, 0.6, 2.0);
  scene.add(ambient, hemi, fill);
  const shine = makeShinePoint(scene);
  const shine2 = makeShinePoint(scene);
  placeShinePoint(shine, lookTune.shineX, lookTune.shineY, lookTune.key);
  placeShinePoint(shine2, lookTune.shine2X, lookTune.shine2Y, lookTune.highlights >= 2 ? lookTune.key * 0.7 : 0);

  const look = lookForColor(item.color);
  const body = item.body && BODIES[item.body] ? item.body : "rounder";
  const bot = new GrokBot({ radius: 1, color: look.body, eyeColor: look.eye, body });
  applyBodyLook(bot, look);
  scene.add(bot);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  frameCamera(camera, item.framing, body);

  let canvas = item.el.querySelector("canvas.avatar-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "avatar-canvas";
    canvas.setAttribute("aria-hidden", "true");
    item.el.appendChild(canvas);
  }
  const ctx = canvas.getContext("2d");
  sizeCanvas(canvas, item.size || 36);
  return {
    el: item.el,
    canvas,
    ctx,
    scene,
    camera,
    bot,
    size: item.size || 36,
    color: item.color,
    framing: item.framing || "icon",
    body,
    moodKey: "",
    lights: { ambient, hemi, fill, shine, shine2 },
  };
}

function frameCamera(camera, framing, body) {
  if (framing === "body") {
    camera.position.set(0, 0.08, 7.6);
    camera.lookAt(0, -0.12, 0);
    return;
  }
  if (framing === "face") {
    camera.position.set(0.04, 0.08, 4.6);
    camera.lookAt(0, -0.04, 0);
    return;
  }
  camera.position.set(0.03, 0.18, 5.85);
  camera.lookAt(0, -0.12, 0);
}

function applyView(view, item) {
  const size = item.size || 36;
  if (view.size !== size) {
    view.size = size;
    sizeCanvas(view.canvas, size);
  }
  const framing = item.framing || "icon";
  const body = item.body && BODIES[item.body] ? item.body : "rounder";
  if (framing !== view.framing || body !== view.body) {
    view.framing = framing;
    view.body = body;
    view.bot.setBody(body);
    frameCamera(view.camera, framing, body);
  }
  if (item.color && item.color !== view.color) {
    view.color = item.color;
    applyBodyLook(view.bot, lookForColor(item.color));
  }
  const mood = item.mood || defaultAvatar();
  const moodKey = `${mood.expression}:${mood.animation}`;
  if (moodKey !== view.moodKey) {
    view.moodKey = moodKey;
    if (view.bot.expression !== mood.expression) view.bot.setExpression(mood.expression);
    if (view.bot.animation !== mood.animation) view.bot.playAnimation(mood.animation);
  }
}

function sizeCanvas(canvas, css) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.max(24, Math.round(css * dpr));
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
}

function lookForColor(hex) {
  const fallback = {
    body: 0xc44dff,
    eye: 0x111111,
    dark: false,
    blush: 0xffb3c6,
    heart: 0xff5a7a,
    star: 0xffd44d,
    tear: 0x7ec8f5,
  };
  if (!hex) return fallback;
  try {
    const tint = new THREE.Color(hex);
    const luma = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b;
    const dark = luma < 0.16;
    const body = tint.clone();
    if (!dark) body.offsetHSL(0, lookTune.punch, 0.05);
    else body.offsetHSL(0, lookTune.punch * 0.5, 0.04);
    return {
      body: body.getHex(),
      eye: dark ? 0xf4f4f5 : 0x111111,
      dark,
      blush: 0xffb3c6,
      heart: 0xff5a7a,
      star: 0xffd44d,
      tear: 0x7ec8f5,
    };
  } catch {
    return fallback;
  }
}

function applyBodyLook(bot, look) {
  bot.bodyMaterial.color.set(look.body);
  if (!bot._baseBodyColor) bot._baseBodyColor = new THREE.Color();
  bot._baseBodyColor.set(look.body);
  bot.eyeMaterial.color.set(look.eye);
  if ("metalness" in bot.bodyMaterial) bot.bodyMaterial.metalness = 0;
  if ("sheenColor" in bot.bodyMaterial) bot.bodyMaterial.sheenColor.set(look.body);
  applyMaterialTune(bot);
  if (bot.blushMaterial) {
    bot.blushMaterial.color.set(look.blush || 0xffb4c8);
    bot.blushMaterial.opacity = look.dark ? 0.78 : 0.7;
  }
  if (bot.accentMaterial) bot.accentMaterial.color.set(look.heart || 0xff5a7a);
  if (bot.starMaterial) bot.starMaterial.color.set(look.star || 0xffd44d);
  if (bot.tearMaterial) bot.tearMaterial.color.set(look.tear || 0x7ec8f5);
  if (bot.fillMaterial) bot.fillMaterial.color.set(0xfffaf3);
  if (bot.whiteMaterial) bot.whiteMaterial.color.set(0xffffff);
  if (bot.pupilMaterial) bot.pupilMaterial.color.set(0x111111);
}

function tick(now) {
  if (!views.size) {
    looping = false;
    return;
  }
  const delta = Math.min(0.05, (now - last) / 1000);
  last = now;
  ensureRenderer();
  for (const view of views.values()) {
    if (!view.el.isConnected) continue;
    view.bot.update(delta);
    const px = view.canvas.width;
    if (px !== lastPx) {
      renderer.setSize(px, px, false);
      lastPx = px;
    }
    renderer.setViewport(0, 0, px, px);
    renderer.render(view.scene, view.camera);
    view.ctx.clearRect(0, 0, px, px);
    view.ctx.drawImage(renderer.domElement, 0, 0, px, px);
  }
  requestAnimationFrame(tick);
}

function disposeView(view) {
  view.scene.traverse((obj) => {
    if (obj.isLight) obj.dispose?.();
  });
  view.bot.dispose();
}

export function bodyList() {
  return Object.entries(BODIES).map(([id, body]) => ({ id, label: body.label }));
}

export function faceList() {
  return Object.entries(EXPRESSIONS).map(([id, exp]) => ({ id, label: exp.label }));
}

const HAPPY_FACES = ["happy", "blush", "grin", "beam", "laugh", "joy", "wink", "love", "hearts", "star", "yum"];
const HAPPY_ANIMS = ["bounce", "cheer", "pulse", "excited"];
const IDLE_FACES = [
  "slight",
  "happy",
  "blush",
  "grin",
  "beam",
  "wink",
  "smirk",
  "love",
  "hearts",
  "yum",
  "tongue",
  "think",
  "raised",
  "unamused",
  "deadpan",
  "oops",
  "cool",
  "relieved",
  "pensive",
  "confused",
  "wow",
  "flushed",
  "zany",
  "shush",
  "eyeroll",
  "star",
  "kiss",
  "winkTongue",
];
const IDLE_ANIMS = ["idle", "sway", "peek", "look"];
const idleMoodByBot = new Map();

export function isSleepingMood(mood) {
  const e = mood?.expression || "";
  const a = mood?.animation || "";
  return a === "sleep" || e === "sleepy" || e === "sleep" || e === "yawn" || e === "drool";
}

export function randomWakeMood() {
  const faces = HAPPY_FACES.filter((id) => EXPRESSIONS[id]);
  const anims = HAPPY_ANIMS.filter((id) => ANIMATIONS[id]);
  const expression = faces[Math.floor(Math.random() * faces.length)] || "happy";
  const animation = anims[Math.floor(Math.random() * anims.length)] || "bounce";
  return defaultAvatar({ expression, animation });
}

export function animList() {
  const rows = Object.entries(ANIMATIONS).map(([id, anim]) => ({
    id,
    label: id === "none" ? "Still" : anim.label,
  }));
  rows.sort((a, b) => (a.id === "none") - (b.id === "none"));
  return rows;
}
