/**
 * Shared helpers for the Sub8 testing suite.
 *
 * Pure Node ESM, no deps. Nothing here ever prints a secret value — secrets are
 * loaded from sub8-cloud/.env into an in-memory map and only their presence is
 * ever reported (see loadCloudEnv / hasSecret).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOT = path.resolve(HERE, "..", "..");
export const CLOUD = path.resolve(BOT, "..", "sub8-cloud");
export const DATA_DIR = path.join(BOT, "data");
export const PROD = (process.env.SUB8_PROD || "https://sub8.bot").replace(/\/$/, "");
export const LOCAL_APP = (process.env.SUB8_LOCAL_APP || "http://127.0.0.1:8901").replace(/\/$/, "");

export const now = () => Math.floor(Date.now() / 1000);

/** execFile as a promise. Never rejects — returns {ok, code, out, secs}. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout || 180_000,
        maxBuffer: 64 * 1024 * 1024,
        cwd: opts.cwd,
        env: { ...process.env, _ZO_DOCTOR: "0", ...(opts.env || {}) },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          out: `${stdout || ""}${stderr || ""}`,
          secs: Math.round((Date.now() - t0) / 1000),
        });
      },
    );
  });
}

/** fetch a URL (absolute, or a path against `base`). Never throws. */
export async function http(base, pathname, { method = "GET", body, headers, timeout = 12_000 } = {}) {
  const url = /^https?:/i.test(pathname) ? pathname : `${base}${pathname}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json, secs: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    return { status: 0, text: String(e?.message || e), json: null, secs: Math.round((Date.now() - t0) / 1000) };
  }
}

// ---- secrets from sub8-cloud/.env (values never printed) ----
let cloudEnvCache = null;
export function loadCloudEnv() {
  if (cloudEnvCache) return cloudEnvCache;
  const map = {};
  try {
    const raw = fs.readFileSync(path.join(CLOUD, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      map[k] = v;
    }
  } catch {
    /* .env may be absent in CI; presence checks will just report false */
  }
  cloudEnvCache = map;
  return map;
}
export function getSecret(name) {
  return process.env[name] || loadCloudEnv()[name] || "";
}
export function hasSecret(name) {
  return Boolean(getSecret(name));
}

/**
 * Run a D1 query through wrangler in the sub8-cloud dir. Reads are the default;
 * pass {mutate:true} for an UPDATE (used by the safe healer). Returns rows[].
 * Throws on failure so callers can decide how to record it.
 */
export async function wrangler(command, { mutate = false, remote = true } = {}) {
  const s = String(command || "").trim();
  if (!mutate && !/^select\b/i.test(s)) throw new Error("read helper only runs SELECT (pass mutate:true)");
  const r = await run(
    "npx",
    ["wrangler", "d1", "execute", "sub8", remote ? "--remote" : "--local", "--json", "--command", s],
    { cwd: CLOUD, timeout: 60_000 },
  );
  const text = r.out || "";
  const i = text.indexOf("[");
  if (i < 0) throw new Error(`wrangler: no output (${text.slice(-200)})`);
  let parsed;
  try { parsed = JSON.parse(text.slice(i)); } catch (e) { throw new Error(`wrangler: bad JSON (${String(e).slice(0, 120)})`); }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first && first.success === false) throw new Error(first.error || "query failed");
  return first?.results || [];
}

/** Stripe REST call using a secret key. Never throws; returns {status, json, error}. */
export async function stripe(secretKey, method, apiPath, params = {}) {
  if (!secretKey) return { status: 0, json: null, error: "no stripe key" };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
  const isGet = method.toUpperCase() === "GET";
  const url = `https://api.stripe.com${apiPath}${isGet && qs.toString() ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(isGet ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      body: isGet ? undefined : qs.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, error: json?.error?.message || "" };
  } catch (e) {
    return { status: 0, json: null, error: String(e?.message || e) };
  }
}

/** DigitalOcean REST GET. Never throws; returns {status, json, error}. */
export async function digitalOcean(token, apiPath) {
  if (!token) return { status: 0, json: null, error: "no DO token" };
  try {
    const res = await fetch(`https://api.digitalocean.com${apiPath}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, error: res.ok ? "" : `DO ${res.status}` };
  } catch (e) {
    return { status: 0, json: null, error: String(e?.message || e) };
  }
}

/** Import a fresh copy of a module (cache-busted) so live probes re-run. */
export function freshImport(absPath) {
  return import(`file://${absPath}?t=${Date.now()}`);
}
