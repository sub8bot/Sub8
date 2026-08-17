#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dockerHost = process.env.DOCKER_HOST || `unix://${os.homedir()}/.colima/default/docker.sock`;

function docker(args) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, DOCKER_HOST: dockerHost },
  });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

function volumeFor(container) {
  const r = docker([
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Name}}{{end}}{{end}}',
    container,
  ]);
  return r.ok ? r.out.trim() : "";
}

function relinkBots(file) {
  if (!fs.existsSync(file)) return { file, skipped: true };
  const bots = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(bots)) return { file, error: "not a bot list" };
  let n = 0;
  for (const bot of bots) {
    const name = bot.vm?.container || `localbot-${String(bot.id || "").slice(0, 8)}`;
    const vol = volumeFor(name);
    if (!vol) continue;
    bot.vm = { ...(bot.vm || {}), container: name, volume: vol };
    n += 1;
  }
  fs.writeFileSync(file, JSON.stringify(bots, null, 2));
  return { file, relinked: n };
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

const home = os.homedir();
const oldData = path.join(home, "Library", "Application Support", "OctoBot", "data");
const newData = path.join(home, "Library", "Application Support", "Sub8Bot", "data");
if (fs.existsSync(path.join(oldData, "bots.json")) && !fs.existsSync(path.join(newData, "bots.json"))) {
  copyDir(oldData, newData);
  console.log(`copied ${oldData} -> ${newData}`);
}

const files = [path.resolve("data/bots.json"), path.join(newData, "bots.json")];
for (const extra of process.argv.slice(2)) files.push(path.resolve(extra));
for (const file of [...new Set(files)]) console.log(relinkBots(file));
