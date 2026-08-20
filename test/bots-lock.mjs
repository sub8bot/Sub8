import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub8-bots-lock-"));
fs.mkdirSync(path.join(tmp, "conversations"), { recursive: true });
fs.mkdirSync(path.join(tmp, "screens"), { recursive: true });

const env = { ...process.env, SUB8BOT_DATA: tmp, SUB8BOT_ROOT: root };

function run(script) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    cwd: root,
  });
  if (r.status !== 0) throw new Error(`${r.stderr || ""}\n${r.stdout || ""}\nexit ${r.status}`);
  return r.stdout.trim();
}

const storeUrl = JSON.stringify(path.join(root, "server", "store.mjs"));

run(`
import * as store from ${storeUrl};
const a = store.newBot({ name: "A" });
a.id = "11111111-1111-4111-8111-111111111111";
await store.upsertBot(a);
const b = store.newBot({ name: "B" });
b.id = "22222222-2222-4222-8222-222222222222";
await store.upsertBot(b);
console.log((await store.loadBots()).map((x) => x.name).sort().join(","));
`);

const botsPath = path.join(tmp, "bots.json");
assert.equal(JSON.parse(fs.readFileSync(botsPath, "utf8")).length, 2);

fs.writeFileSync(botsPath, "{not json");
let threw = false;
try {
  run(`import * as store from ${storeUrl}; await store.loadBots();`);
} catch (err) {
  threw = /JSON|not json|SyntaxError/i.test(String(err.message || err));
}
assert.equal(threw, true);
assert.equal(fs.readFileSync(botsPath, "utf8"), "{not json");

try {
  run(`import * as store from ${storeUrl}; const b = store.newBot({ name: "C" }); await store.upsertBot(b);`);
} catch {
  /* must not rewrite corrupt file as a one-bot list */
}
assert.equal(fs.readFileSync(botsPath, "utf8"), "{not json");

fs.writeFileSync(botsPath, JSON.stringify([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Keep", harness: { provider: "claude" }, vm: {}, messages: [], routines: [] }], null, 2));
run(`
import * as store from ${storeUrl};
const added = await store.recoverMissingBots([
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Keep" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "bagel-scout", teamId: "t1", teamRole: "worker" },
]);
if (added.length !== 1 || added[0].name !== "bagel-scout") throw new Error("recover should add only the missing row");
const names = (await store.loadBots()).map((b) => b.name).sort();
if (names.join(",") !== "Keep,bagel-scout") throw new Error(names.join(","));
`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok bots-lock");
