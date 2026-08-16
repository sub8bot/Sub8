import * as THREE from "three";
import { ANIMATIONS, BODIES, EXPRESSIONS, GrokBot } from "./grok-bot.js";

export { ANIMATIONS, BODIES, EXPRESSIONS };

const views = new Map();
let renderer = null;
let last = performance.now();
let looping = false;
let lastPx = 0;

const REACT_MS = 28_000;
const DONE_MS = 9_000;

const RE = {
  frustrated:
    /\b(ugh+|argh+|frustrated|frustrating|annoying|this (sucks|is broken)|still broken|why (isn'?t|won'?t|can'?t)|i('m| am) (so )?(tired|done|fed up)|hate this|come on|seriously\??|fix (it|this)|doesn'?t work)\b/i,
  angry: /\b(angry|furious|pissed|wtf|damn it|goddamn|rage)\b/i,
  sad: /\b(sad|upset|disappointed|sorry|depressed|miserable)\b/i,
  confused: /\b(confused|huh\??|i don'?t (get|understand)|wait what|how (do|does|come)|what does that)\b/i,
  love: /\b(love (you|this|it)|you'?re the best|thank(s| you)|awesome job|perfect)\b/i,
  happy: /\b(yay+|woo+|nice|great|awesome|amazing|lol|haha|hehe|good (job|work))\b/i,
  wow: /\b(whoa+|wow+|omg|no way|incredible)\b/i,
  sleepy: /\b(tired|sleepy|good night|zzz+|bored)\b/i,
};

export function defaultAvatar(partial = {}) {
  const expression = EXPRESSIONS[partial.expression] ? partial.expression : "neutral";
  const animation = ANIMATIONS[partial.animation] ? partial.animation : "idle";
  return { expression, animation, body: "smooth" };
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
    if (RE.angry.test(text)) return pack("angry", reduce ? "none" : "shake");
    if (RE.frustrated.test(text)) return pack("sad", reduce ? "none" : "nod");
    if (RE.sad.test(text)) return pack("sad", reduce ? "none" : "idle");
    if (RE.confused.test(text)) return pack("confused", reduce ? "none" : "look");
    if (RE.love.test(text)) return pack("love", reduce ? "none" : "bounce");
    if (RE.wow.test(text)) return pack("wow", reduce ? "none" : "excited");
    if (RE.happy.test(text)) return pack("happy", reduce ? "none" : "bounce");
    if (RE.sleepy.test(text)) return pack("sleepy", reduce ? "none" : "sleep");
  }

  if (bot?.busy || bot?.vm?.status === "starting") {
    const usingDesk = Boolean(lastTool && (!lastAsst || (lastTool.ts || 0) >= (lastAsst.ts || 0) - 2000));
    return pack(avatar.expression, reduce ? "none" : usingDesk ? "look" : "talk");
  }

  if (lastAsst && asstAge < DONE_MS && userAge < DONE_MS + 4000) {
    return pack(avatar.expression === "neutral" ? "happy" : avatar.expression, reduce ? "none" : "nod");
  }

  const quietFor = Math.min(userAge, asstAge);
  if (quietFor > 12 * 60_000) return pack("sleepy", reduce ? "none" : "sleep");
  if (quietFor > 6 * 60_000) return pack(avatar.expression, reduce ? "none" : "idle");

  return pack(avatar.expression, reduce ? "none" : avatar.animation || "idle");
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0xffe8d2, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(2.2, 2.6, 3.4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff4ea, 0.42);
  fill.position.set(-2.8, 0.45, 1.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.28);
  rim.position.set(0.2, 1.1, -2.6);
  scene.add(rim);

  const look = lookForColor(item.color);
  const body = "smooth";
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
    framing: item.framing || "face",
    body,
    moodKey: "",
  };
}

function frameCamera(camera, framing, body) {
  if (framing === "body") {
    camera.position.set(0.04, 0.08, 6.2);
    camera.lookAt(0, -0.08, 0);
    return;
  }
  camera.position.set(0.08, 0.05, 3.32);
  camera.lookAt(0, 0.02, 0);
}

function applyView(view, item) {
  const size = item.size || 36;
  if (view.size !== size) {
    view.size = size;
    sizeCanvas(view.canvas, size);
  }
  const framing = item.framing || "face";
  const body = "smooth";
  if (framing !== view.framing || body !== view.body) {
    view.framing = framing;
    view.body = body;
    view.bot.setBody();
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
    body: 0xffe566,
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
    const dark = luma < 0.38;
    const body = tint.clone();
    if (!dark) body.offsetHSL(0, 0.02, 0.02);
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
  bot.eyeMaterial.color.set(look.eye);
  bot.bodyMaterial.sheenColor.set(look.dark ? 0x94a3b8 : look.body);
  bot.bodyMaterial.sheen = look.dark ? 0.06 : 0.08;
  bot.bodyMaterial.clearcoat = look.dark ? 0.22 : 0.18;
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

export function animList() {
  const rows = Object.entries(ANIMATIONS).map(([id, anim]) => ({
    id,
    label: id === "none" ? "Still" : anim.label,
  }));
  rows.sort((a, b) => (a.id === "none") - (b.id === "none"));
  return rows;
}
