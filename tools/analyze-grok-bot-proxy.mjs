/** Summarize captured Grok Bot destinations. Does not print secrets. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proxyLog = path.join(root, "data", "traces", "grok-bot-proxy.jsonl");
const netlog = path.join(root, "data", "traces", "grok-bot-netlog.json");

const hosts = new Map();
if (fs.existsSync(proxyLog)) {
  for (const line of fs.readFileSync(proxyLog, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const h = ev.host || ev.url || "";
      if (!h) continue;
      hosts.set(h, (hosts.get(h) || 0) + 1);
    } catch {
      /* skip */
    }
  }
}

console.log("=== CONNECT destinations ===");
for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(5), h);
}

if (fs.existsSync(netlog)) {
  const raw = fs.readFileSync(netlog, "utf8");
  const urls = new Map();
  for (const m of raw.matchAll(/https:\/\/[a-zA-Z0-9._:-]+(?:\/[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?/g)) {
    try {
      const u = new URL(m[0]);
      const key = u.host + u.pathname.split("?")[0];
      urls.set(key, (urls.get(key) || 0) + 1);
    } catch {
      /* skip */
    }
  }
  console.log("\n=== netlog URL paths (top 40) ===");
  for (const [k, n] of [...urls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(String(n).padStart(5), k);
  }
}

const known = {
  "100.22.187.221": "likely AWS / Anysphere gateway",
  "52.13.104.179": "likely AWS us-west",
  "44.218.134.82": "likely AWS us-east",
  "54.211.243.170": "likely AWS us-east",
};
console.log("\n=== known live sockets (from last inspect) ===");
for (const [ip, note] of Object.entries(known)) console.log(ip, note);

try {
  const addrs = await dns.resolve4("api.x.ai").catch(() => []);
  console.log("api.x.ai A", addrs.join(", ") || "(none)");
} catch {
  /* ignore */
}
