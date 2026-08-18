import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir } from "./paths.mjs";
import * as vm from "./vm.mjs";

const VAULT_PATH = path.join(dataDir, "vault.enc");
const KEY_PATH = path.join(dataDir, ".vault.key");
const ALGO = "aes-256-gcm";

let cachedKey = null;
let writeLock = Promise.resolve();

function emptyVault() {
  return { version: 1, groups: [], accounts: [], grants: {} };
}

function withLock(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function keyFromEnv() {
  const raw = String(process.env.SUB8BOT_VAULT_KEY || "").trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, /^[A-Fa-f0-9]{64}$/.test(raw) ? "hex" : "base64");
  return buf.length === 32 ? buf : null;
}

function keychainRead() {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("security", ["find-generic-password", "-a", "sub8bot", "-s", "Sub8VaultKey", "-w"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const buf = Buffer.from(String(r.stdout || "").trim(), "base64");
  return buf.length === 32 ? buf : null;
}

function keychainWrite(key) {
  if (process.platform !== "darwin") return false;
  const b64 = key.toString("base64");
  const r = spawnSync(
    "security",
    ["add-generic-password", "-a", "sub8bot", "-s", "Sub8VaultKey", "-w", b64, "-U"],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

async function loadOrCreateKey() {
  if (cachedKey) return cachedKey;
  const fromEnv = keyFromEnv();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }
  const fromChain = keychainRead();
  if (fromChain) {
    cachedKey = fromChain;
    return cachedKey;
  }
  await fs.mkdir(dataDir, { recursive: true });
  if (fsSync.existsSync(KEY_PATH)) {
    const raw = (await fs.readFile(KEY_PATH, "utf8")).trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  }
  const key = randomBytes(32);
  if (!keychainWrite(key)) {
    await fs.writeFile(KEY_PATH, key.toString("base64"), { mode: 0o600 });
    await fs.chmod(KEY_PATH, 0o600).catch(() => {});
  }
  cachedKey = key;
  return cachedKey;
}

function seal(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  });
}

function openSealed(raw, key) {
  const doc = JSON.parse(raw);
  const iv = Buffer.from(doc.iv, "base64");
  const tag = Buffer.from(doc.tag, "base64");
  const data = Buffer.from(doc.data, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function readVault() {
  const key = await loadOrCreateKey();
  if (!fsSync.existsSync(VAULT_PATH)) return emptyVault();
  try {
    const raw = await fs.readFile(VAULT_PATH, "utf8");
    const data = JSON.parse(openSealed(raw, key));
    return {
      version: 1,
      groups: Array.isArray(data.groups) ? data.groups : [],
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      grants: data.grants && typeof data.grants === "object" ? data.grants : {},
    };
  } catch {
    throw new Error("Vault file is present but could not be decrypted.");
  }
}

async function writeVault(data) {
  const key = await loadOrCreateKey();
  await fs.mkdir(dataDir, { recursive: true });
  const body = seal(JSON.stringify(data), key);
  const tmp = `${VAULT_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  try {
    await fs.rename(tmp, VAULT_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export function publicAccount(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    groupId: acc.groupId || "",
    label: acc.label || "",
    site: acc.site || "",
    username: acc.username || "",
    hasPassword: Boolean(acc.password),
    notes: acc.notes || "",
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
    lastUsedAt: acc.lastUsedAt || null,
  };
}

export async function snapshot() {
  const v = await readVault();
  return {
    groups: v.groups,
    accounts: v.accounts.map(publicAccount),
    grants: v.grants,
  };
}

export async function upsertGroup({ id, name }) {
  return withLock(async () => {
    const v = await readVault();
    const label = String(name || "").trim() || "Group";
    let group = id ? v.groups.find((g) => g.id === id) : null;
    if (group) {
      group.name = label;
    } else {
      group = { id: randomUUID(), name: label, createdAt: Date.now() };
      v.groups.push(group);
    }
    await writeVault(v);
    return group;
  });
}

export async function deleteGroup(id) {
  return withLock(async () => {
    const v = await readVault();
    v.groups = v.groups.filter((g) => g.id !== id);
    for (const acc of v.accounts) {
      if (acc.groupId === id) acc.groupId = "";
    }
    await writeVault(v);
    return snapshotUnlocked(v);
  });
}

function snapshotUnlocked(v) {
  return {
    groups: v.groups,
    accounts: v.accounts.map(publicAccount),
    grants: v.grants,
  };
}

export async function upsertAccount(spec = {}) {
  return withLock(async () => {
    const v = await readVault();
    const now = Date.now();
    let acc = spec.id ? v.accounts.find((a) => a.id === spec.id) : null;
    if (!acc) {
      acc = {
        id: randomUUID(),
        groupId: "",
        label: "",
        site: "",
        username: "",
        password: "",
        notes: "",
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      };
      v.accounts.push(acc);
    }
    if (typeof spec.groupId === "string") acc.groupId = spec.groupId;
    if (typeof spec.label === "string") acc.label = spec.label.trim();
    if (typeof spec.site === "string") acc.site = spec.site.trim();
    if (typeof spec.username === "string") acc.username = spec.username;
    if (typeof spec.password === "string" && spec.password !== "••••") acc.password = spec.password;
    if (typeof spec.notes === "string") acc.notes = spec.notes;
    if (!acc.label) acc.label = acc.site || acc.username || "Account";
    acc.updatedAt = now;
    await writeVault(v);
    return publicAccount(acc);
  });
}

export async function deleteAccount(id) {
  return withLock(async () => {
    const v = await readVault();
    v.accounts = v.accounts.filter((a) => a.id !== id);
    for (const botId of Object.keys(v.grants)) {
      v.grants[botId] = (v.grants[botId] || []).filter((x) => x !== id);
    }
    await writeVault(v);
    return snapshotUnlocked(v);
  });
}

export async function setGrants(botId, accountIds) {
  return withLock(async () => {
    const v = await readVault();
    const known = new Set(v.accounts.map((a) => a.id));
    v.grants[botId] = [...new Set((accountIds || []).filter((id) => known.has(id)))];
    await writeVault(v);
    return v.grants[botId];
  });
}

export async function grantedAccounts(botId) {
  const v = await readVault();
  const ids = new Set(v.grants[botId] || []);
  return v.accounts.filter((a) => ids.has(a.id)).map(publicAccount);
}

function accountForBot(v, botId, accountId) {
  const allowed = new Set(v.grants[botId] || []);
  if (!allowed.has(accountId)) return null;
  return v.accounts.find((a) => a.id === accountId) || null;
}

export async function revealAccount(id) {
  const v = await readVault();
  const acc = v.accounts.find((a) => a.id === id);
  if (!acc) return null;
  return { ...publicAccount(acc), password: acc.password || "" };
}

export async function fieldForBot(botId, accountId, field) {
  return withLock(async () => {
    const v = await readVault();
    const acc = accountForBot(v, botId, accountId);
    if (!acc) return { ok: false, error: "This Bot cannot use that login." };
    const key = field === "username" ? "username" : "password";
    const value = String(acc[key] || "");
    if (!value) return { ok: false, error: `No ${key} saved for ${acc.label}.` };
    acc.lastUsedAt = Date.now();
    await writeVault(v);
    return { ok: true, account: publicAccount(acc), field: key, value };
  });
}

export async function listSecrets() {
  const v = await readVault();
  return v.accounts.map((a) => a.password).filter((p) => p && String(p).length >= 4);
}

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  if (!out || !secrets?.length) return out;
  for (const secret of secrets) {
    if (!secret || String(secret).length < 4) continue;
    const esc = String(secret).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), "[secret]");
  }
  return out;
}

export async function promptBlock(botId) {
  const rows = await grantedAccounts(botId);
  if (!rows.length) {
    return `
## Password vault
You have no saved logins yet. To sign in: (1) ask them to add the account in the vault (lock icon) and grant this Bot, or (2) ask them to press Take control and sign in themselves, or (3) register a new account if they asked you to, then have them save it in the vault. Never invent a password for an account they already have. Never ask them to paste a password into chat.
`;
  }
  const lines = rows.map((a) => `- ${a.label} (${a.site || "site unknown"}) id=${a.id} username=${a.username || "(none)"}`);
  return `
## Password vault
You may use ONLY these saved logins. The password is never shown to you.
${lines.join("\n")}
To sign in: click the field, then call vault_fill with account_id and field=username or field=password. On this computer you can also run \`octo-vault fill <id> username|password\` after focusing the field.
Never type, print, or send a password. Never put a secret in chat, send_message, notes, or the shell. If a site asks for a password, vault_fill it.
`;
}

export async function fillIntoDesktop(bot, accountId, field) {
  const got = await fieldForBot(bot.id, accountId, field);
  if (!got.ok) return { ok: false, text: got.error };
  await vm.pasteSecret(bot, got.value);
  return {
    ok: true,
    text: `Pasted ${got.field} for “${got.account.label}”. The secret is not shown here.`,
    account: got.account,
    field: got.field,
  };
}

export async function pushListToBot(bot) {
  if (!bot?.vm?.container) return;
  const rows = await grantedAccounts(bot.id);
  const body = JSON.stringify({ accounts: rows }, null, 2);
  try {
    await vm.writeFileToContainer(bot.vm.container, "/config/.sub8-vault-list.json", body);
  } catch {
    /* computer may still be booting */
  }
}

async function handleVaultRequest(bot) {
  const box = bot?.vm?.container;
  if (!box) return;
  const peek = await vm.docker(
    ["exec", "-u", "abc", box, "bash", "-lc", "cat /tmp/sub8-vault-req.json 2>/dev/null || true"],
    { timeout: 2500 },
  );
  const raw = String(peek.out || "").trim();
  if (!raw) return;
  await vm.docker(["exec", "-u", "abc", box, "rm", "-f", "/tmp/sub8-vault-req.json"]);
  let req = {};
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  const cmd = String(req.cmd || "fill");
  let result;
  if (cmd === "list") {
    result = { ok: true, accounts: await grantedAccounts(bot.id) };
  } else {
    const filled = await fillIntoDesktop(bot, req.accountId, req.field || "password");
    result = { ok: filled.ok, message: filled.text };
  }
  const tmp = path.join(os.tmpdir(), `sub8-vault-done-${Date.now()}.json`);
  await fs.writeFile(tmp, JSON.stringify(result));
  try {
    await vm.docker(["cp", tmp, `${box}:/tmp/sub8-vault-done.json`]);
    await vm.docker(["exec", "-u", "root", box, "bash", "-lc", "chown abc:abc /tmp/sub8-vault-done.json"]);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export function startVaultBridge(loadBots) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const bots = await loadBots();
      for (const bot of bots) {
        // octo-vault file drops are only used by Grok Build inside the VM.
        const provider = bot.harness?.provider;
        if (provider && provider !== "default" && provider !== "grok-build") continue;
        if (bot.vm?.status !== "running" || !bot.vm.container) continue;
        await handleVaultRequest(bot).catch(() => {});
      }
    } finally {
      ticking = false;
    }
  };
  setInterval(() => tick().catch(() => {}), 2000);
  return tick;
}

/** Test helper: reset in-memory key (does not delete files). */
export function _resetKeyCache() {
  cachedKey = null;
}
