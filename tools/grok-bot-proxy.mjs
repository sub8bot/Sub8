/**
 * Destination proxy for /Applications/Grok Bot.app
 *
 * Logs every CONNECT/HTTP target (host:port) without decrypting TLS.
 * Launch Grok Bot through it:
 *   node tools/grok-bot-proxy.mjs
 *   open -na "Grok Bot" --args --proxy-server=127.0.0.1:8899
 *
 * Writes: data/traces/grok-bot-proxy.jsonl
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.GROK_BOT_PROXY_PORT || 8899);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logFile = path.join(root, "data", "traces", "grok-bot-proxy.jsonl");
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(rec) {
  const line = JSON.stringify({ ts: Date.now(), ...rec }) + "\n";
  fs.appendFileSync(logFile, line);
  const tag = rec.host || rec.url || "?";
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${rec.op} ${tag}\n`);
}

const server = http.createServer((req, res) => {
  log({ op: "http", method: req.method, url: req.url, host: req.headers.host || "" });
  res.writeHead(502, { "content-type": "text/plain" });
  res.end("CONNECT-only proxy. Use HTTPS via CONNECT.");
});

server.on("connect", (req, client, head) => {
  const [host, portStr] = String(req.url || "").split(":");
  const port = Number(portStr || 443);
  log({ op: "connect", host, port });
  const upstream = net.connect(port, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Grok Bot proxy on 127.0.0.1:${PORT}`);
  console.log(`log ${logFile}`);
  console.log(`open -na "Grok Bot" --args --proxy-server=127.0.0.1:${PORT}`);
});
