#!/usr/bin/env node
/**
 * Draw docs/brand/star-history.svg from this repo's stargazers.
 * Needs `gh` authenticated as someone who can read the stargazer timestamps
 * (repo owner). Third-party hosts like star-history.com cannot.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "brand", "star-history.svg");
const OWNER = "sub8bot";
const REPO = "Sub8";

function ghJson(url) {
  const raw = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.star+json", url], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function allStars() {
  const times = [];
  let page = 1;
  while (page < 50) {
    const rows = ghJson(`/repos/${OWNER}/${REPO}/stargazers?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) if (r.starred_at) times.push(new Date(r.starred_at));
    if (rows.length < 100) break;
    page += 1;
  }
  times.sort((a, b) => a - b);
  return times;
}

function fmtDay(d) {
  return d.toISOString().slice(0, 10);
}

function series(times) {
  if (!times.length) return [];
  const start = new Date(fmtDay(times[0]) + "T00:00:00Z");
  const end = new Date(fmtDay(times.at(-1)) + "T00:00:00Z");
  const days = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) days.push(new Date(t));
  const pts = [];
  let i = 0;
  for (const day of days) {
    const next = new Date(day.getTime() + 86400000);
    while (i < times.length && times[i] < next) i += 1;
    pts.push({ day, n: i });
  }
  return pts;
}

function svg(pts, total) {
  const W = 720;
  const H = 280;
  const padL = 48;
  const padR = 24;
  const padT = 36;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const ymax = Math.max(10, Math.ceil(total / 5) * 5);
  const n = Math.max(pts.length - 1, 1);
  const xAt = (i) => padL + (i / n) * plotW;
  const yAt = (v) => padT + plotH - (v / ymax) * plotH;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p.n).toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(pts.length - 1).toFixed(1)},${yAt(0).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} Z`;
  const yTicks = [];
  const step = ymax <= 20 ? 5 : ymax <= 50 ? 10 : 25;
  for (let v = 0; v <= ymax; v += step) yTicks.push(v);
  const xLabels = [];
  const labelEvery = pts.length <= 8 ? 1 : pts.length <= 16 ? 2 : Math.ceil(pts.length / 6);
  pts.forEach((p, i) => {
    if (i % labelEvery === 0 || i === pts.length - 1) {
      const md = `${p.day.getUTCMonth() + 1}/${p.day.getUTCDate()}`;
      xLabels.push({ i, md });
    }
  });
  const grid = yTicks
    .map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}" stroke="#e8e4ef" stroke-width="1"/>`)
    .join("\n    ");
  const yText = yTicks
    .map((v) => `<text x="${padL - 8}" y="${yAt(v) + 4}" text-anchor="end" fill="#6b6575" font-size="11">${v}</text>`)
    .join("\n    ");
  const xText = xLabels
    .map(({ i, md }) => `<text x="${xAt(i).toFixed(1)}" y="${H - 14}" text-anchor="middle" fill="#6b6575" font-size="11">${md}</text>`)
    .join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sub8 GitHub stars over time, ${total} stars">
  <rect width="${W}" height="${H}" rx="12" fill="#fbf8fc"/>
  <text x="${padL}" y="22" fill="#2b2433" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-weight="600">Stargazers · ${total}</text>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
    ${grid}
    <path d="${area}" fill="#c56dd1" fill-opacity="0.18"/>
    <path d="${line}" fill="none" stroke="#9b6dd1" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xAt(pts.length - 1).toFixed(1)}" cy="${yAt(pts.at(-1).n).toFixed(1)}" r="4" fill="#9b6dd1"/>
    ${yText}
    ${xText}
  </g>
</svg>
`;
}

const times = allStars();
const pts = series(times);
if (!pts.length) {
  console.error("no stargazers");
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg(pts, times.length));
console.log(`wrote ${path.relative(root, out)} (${times.length} stars, ${pts.length} days)`);
