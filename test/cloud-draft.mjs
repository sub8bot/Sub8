import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-cloud-draft-"));
process.env.SUB8BOT_DATA = tmp;

const draft = await import(path.join(root, "server/cloud/draft.mjs"));

const desk = await draft.createComputer({ name: "Night desk", size: "8gb" });
assert.equal(desk.kind, "cloud-draft");
assert.equal(desk.ram, "8 GB");
assert.equal(desk.draft, true);

const bot = await draft.createBot({ name: "Piper", computerId: desk.id });
assert.equal(bot.place, "cloud");
assert.equal(bot.vm.kind, "cloud-draft");
assert.ok((bot.messages || []).length >= 1);

const talked = await draft.addMessage(bot.id, "hello from draft");
assert.equal(talked.messages.at(-2).role, "user");
assert.equal(talked.messages.at(-1).role, "assistant");

const signed = await draft.patchComputer(desk.id, { harness: { signedIn: true, provider: "grok-build" } });
assert.equal(signed.harness.signedIn, true);

assert.equal(await draft.destroyComputer(desk.id), true);
const snap = await draft.snapshot();
assert.equal(snap.computers.length, 0);
assert.equal(snap.bots.length, 0);

await fs.rm(tmp, { recursive: true, force: true });
console.log("ok cloud-draft");
