import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { harvestAuthFile, shareAuthFile } from "../server/host-cli.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-auth-"));
const src = path.join(dir, "host-auth.json");
const dest = path.join(dir, "cli-home", "auth.json");
await fs.writeFile(src, JSON.stringify({ tokens: { refresh_token: "v1" } }));

const linked = await shareAuthFile(src, dest);
assert.equal(linked, "symlink");
assert.equal(await fs.readlink(dest), src);
await fs.writeFile(dest, JSON.stringify({ tokens: { refresh_token: "v2" } }));
assert.equal(JSON.parse(await fs.readFile(src, "utf8")).tokens.refresh_token, "v2");
assert.equal(await harvestAuthFile(src, dest), "symlink");

const copyDir = path.join(dir, "copied");
const copyDest = path.join(copyDir, "auth.json");
await fs.mkdir(copyDir);
await fs.writeFile(copyDest, JSON.stringify({ tokens: { refresh_token: "v3" } }));
assert.equal(await harvestAuthFile(src, copyDest), "copied-back");
assert.equal(JSON.parse(await fs.readFile(src, "utf8")).tokens.refresh_token, "v3");

await fs.rm(dir, { recursive: true, force: true });
console.log("ok host-cli-auth");
