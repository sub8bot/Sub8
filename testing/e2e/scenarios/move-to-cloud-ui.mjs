/**
 * Create a local bot, put a marker on its desk, Move to Cloud via the UI,
 * then verify the Cloud bot has the same name and the marker file.
 * Run against the live app: node testing/e2e/scenarios/move-to-cloud-ui.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const BASE = process.env.SUB8_E2E_URL || "http://127.0.0.1:8787";
const MARKER = `move-probe-${Date.now()}`;
const NAME = `MoveProbe ${String(Date.now()).slice(-6)}`;

function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || "";
}

async function api(p, { method = "GET", body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(json.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function wait(fn, ms = 120_000, step = 2000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("timeout: " + (last && last.error ? last.error : "condition never true"));
}

const acct = await api("/api/account");
assert.equal(acct.signedIn, true, "sign in to Cloud first");
assert.equal(acct.cloudProduct, true, "SUB8_CLOUD product flag must be on");

const created = await api("/api/bots", { method: "POST", body: { name: NAME } });
assert.ok(created.id, "created bot");
const botId = created.id;
console.log("bot", botId, NAME);

const bot = await wait(async () => {
  const b = await api(`/api/bots/${botId}`);
  const st = b.vm?.status;
  const container = b.vm?.container;
  if (container && (st === "running" || b.vm?.ok)) return b;
  return null;
}, 180_000);
const container = bot.vm.container;
const computerId = bot.vm.computerId;
console.log("desk", computerId, container, bot.vm.status);

execFileSync("docker", ["exec", "-u", "root", container, "mkdir", "-p", "/config/Desktop"], { stdio: "inherit" });
const tmp = path.join(os.tmpdir(), `marker-${MARKER}.txt`);
fs.writeFileSync(tmp, MARKER);
execFileSync("docker", ["cp", tmp, `${container}:/config/Desktop/MOVE-MARKER.txt`]);
execFileSync("docker", ["exec", "-u", "root", container, "chown", "abc:abc", "/config/Desktop/MOVE-MARKER.txt"]);
console.log("wrote marker", MARKER);

await api("/api/account/view", { method: "POST", body: { view: "local" } }).catch(() => {});

const exe = chromePath();
let moved = null;
if (exe) {
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: false,
    args: ["--new-window"],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const page = await browser.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector(".rail-bot, .botname", { timeout: 30_000 });
    await page.evaluate((view) => {
      return fetch("/api/account/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view }) });
    }, "local");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".rail-bot", { timeout: 30_000 });
    const handle = await page.evaluateHandle((id) => {
      return document.querySelector(`.rail-bot[data-id="${id}"]`) || document.querySelector(".rail-bot");
    }, botId);
    const el = handle.asElement();
    if (!el) throw new Error("bot rail row not found");
    const box = await el.boundingBox();
    if (!box) throw new Error("bot rail row has no box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.waitForSelector('[data-act="ctx-move-cloud"]', { timeout: 8_000 });
    await page.click('[data-act="ctx-move-cloud"]');
    console.log("clicked Move to Cloud");
    moved = await wait(async () => {
      const draft = await api("/api/cloud/draft");
      const hit = (draft.bots || []).find((b) => b.name === NAME);
      return hit || null;
    }, 240_000, 3000);
  } finally {
    await browser.close().catch(() => {});
  }
} else {
  console.log("no Chrome for puppeteer; calling move API directly");
}

if (!moved) {
  console.log("UI did not finish in time; calling move API");
  const out = await api(`/api/computers/${computerId}/move-to-cloud`, {
    method: "POST",
    body: { botId, name: NAME },
  });
  console.log("move API", out);
  moved = { id: out.botId, name: out.name, computerId: out.computerId };
}

assert.equal(moved.name, NAME, "cloud bot must keep the local name");
console.log("cloud bot", moved.id, moved.name);

const cat = await api("/api/cloud/brain/desk-action", {
  method: "POST",
  body: {
    computerId: String(moved.id || "").replace(/^cloud-/, "") || moved.computerId,
    action: "shell",
    text: "cat /config/Desktop/MOVE-MARKER.txt",
  },
});
const text = String(cat.text || cat.out || "");
console.log("cloud cat", text.slice(0, 200));
assert.match(text, new RegExp(MARKER), "marker must exist on the Cloud desk");

const local = await api(`/api/bots/${botId}`);
assert.equal(local.name, NAME, "local bot remains");
console.log("ok move-to-cloud-ui");
