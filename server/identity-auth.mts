/**
 * Per-identity logins for the host CLIs (Claude Code, Codex, Grok Build).
 *
 * The shared identity ("This Mac's login") is the CLI's default login and is
 * never touched here. An isolated identity points the CLI at its own login
 * directory (identities.identityCliEnv), and everything in this file runs the
 * CLI with that env: the status probe, the browser sign-in, and sign-out. So
 * an isolated row reports and changes only its own login.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseClaudeAuthStatus, type IdentityProbeStatus } from "@sub8/harness-auth";
import type { Identity } from "@sub8/identities";
import { dataDir } from "./paths.mjs";
import * as identities from "./identities.mjs";
import { claudeBin, codexBin, grokBin, hostEnv } from "./host-cli.mjs";

type IdentityLike = Pick<Identity, "id" | "place" | "runtimeRef" | "provider"> & Partial<Pick<Identity, "label" | "subject">>;

export interface OwnAuthResult {
  status: IdentityProbeStatus;
  email: string;
  /** Credentials of its own exist (signed in, or a login that expired). null = could not tell. */
  ownCredentials: boolean | null;
  checkedAt: number;
}

export interface RunResult {
  code: number;
  out: string;
}

export type Runner = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<RunResult>;

const defaultRun: Runner = (bin, args, env, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, out: String((e as Error).message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: String(e.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });

function binFor(provider: string): string {
  if (provider === "claude") return claudeBin();
  if (provider === "codex") return codexBin();
  if (provider === "grok-build") return grokBin();
  return "";
}

/** The spawn env for this identity's CLI: this Mac's env plus its own login dir. */
export function envFor(identity: IdentityLike, base: NodeJS.ProcessEnv = hostEnv()): NodeJS.ProcessEnv {
  return { ...identities.applyIdentityEnv(base, identity), NO_COLOR: "1" };
}

/** The email claim of a JWT, read without verifying (display only). */
export function jwtEmail(token: unknown): string {
  const part = String(token || "").split(".")[1];
  if (!part) return "";
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const nested = json["https://api.openai.com/profile"] as { email?: unknown } | undefined;
    return String(json.email || nested?.email || "").trim();
  } catch {
    return "";
  }
}

/** Codex auth.json → whether it holds a login, and its account email. */
export function parseCodexAuth(raw: unknown): { signedIn: boolean; email: string } {
  if (!raw || typeof raw !== "object") return { signedIn: false, email: "" };
  const a = raw as { OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown } | null };
  const t = a.tokens || null;
  const signedIn = Boolean((t && (t.refresh_token || t.access_token)) || a.OPENAI_API_KEY);
  return { signedIn, email: t ? jwtEmail(t.id_token) : "" };
}

/** Grok auth.json (one entry per issuer::client) → whether it holds a login, and its email. */
export function parseGrokAuth(raw: unknown): { signedIn: boolean; email: string } {
  if (!raw || typeof raw !== "object") return { signedIn: false, email: "" };
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as { refresh_token?: unknown; key?: unknown; email?: unknown };
    if (e.refresh_token || e.key) return { signedIn: true, email: String(e.email || "").trim() };
  }
  return { signedIn: false, email: "" };
}

/** `claude auth status` (JSON) → status, email, and whether the dir holds credentials. */
export function parseClaudeOwnStatus(out: string): { status: IdentityProbeStatus; email: string; ownCredentials: boolean | null } {
  const parsed = parseClaudeAuthStatus(out);
  let method = "";
  const blob = out.match(/\{[\s\S]*\}/);
  if (blob) {
    try {
      method = String((JSON.parse(blob[0]) as { authMethod?: unknown }).authMethod || "");
    } catch {
      /* prose */
    }
  }
  if (!blob && !/loggedIn/i.test(out)) return { status: "signed_out", email: "", ownCredentials: null };
  if (parsed.signedIn) return { status: "signed_in", email: parsed.email, ownCredentials: true };
  if (parsed.expired && parsed.email) return { status: "expired", email: parsed.email, ownCredentials: true };
  return { status: "signed_out", email: parsed.email, ownCredentials: Boolean(method && method !== "none") };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Probe one isolated identity's own login. Never the Mac's default login. */
export async function probeOwnAuth(identity: IdentityLike, { run = defaultRun }: { run?: Runner } = {}): Promise<OwnAuthResult> {
  const now = Date.now();
  if (!identities.isIsolatedIdentity(identity)) return { status: "signed_out", email: "", ownCredentials: null, checkedAt: now };
  const dir = identities.identityRuntimeDir(identity);
  if (identity.provider === "claude") {
    // A Keychain item for this dir can only exist if the CLI ran with it, which
    // creates the dir. No dir = never signed in; skip the spawn.
    if (!dir || !fsSync.existsSync(dir)) return { status: "signed_out", email: "", ownCredentials: false, checkedAt: now };
    const bin = binFor("claude");
    if (!bin) return { status: "not_installed", email: "", ownCredentials: null, checkedAt: now };
    const r = await run(bin, ["auth", "status"], envFor(identity), 15_000);
    return { ...parseClaudeOwnStatus(r.out), checkedAt: now };
  }
  if (identity.provider === "codex") {
    const p = parseCodexAuth(await readJson(path.join(dir, "auth.json")));
    return { status: p.signedIn ? "signed_in" : "signed_out", email: p.email, ownCredentials: p.signedIn, checkedAt: now };
  }
  if (identity.provider === "grok-build") {
    const p = parseGrokAuth(await readJson(path.join(dir, "auth.json")));
    return { status: p.signedIn ? "signed_in" : "signed_out", email: p.email, ownCredentials: p.signedIn, checkedAt: now };
  }
  return { status: "signed_out", email: "", ownCredentials: null, checkedAt: now };
}

const cache = new Map<string, OwnAuthResult>();
const CACHE_MS = 30_000;

export function invalidateOwnAuth(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

/** probeOwnAuth, cached briefly so opening Settings does not spawn a CLI per row every paint. */
export async function ownAuth(identity: IdentityLike, opts: { run?: Runner; force?: boolean } = {}): Promise<OwnAuthResult> {
  const hit = cache.get(identity.id);
  if (hit && !opts.force && Date.now() - hit.checkedAt < CACHE_MS) return hit;
  const val = await probeOwnAuth(identity, opts.run ? { run: opts.run } : {});
  cache.set(identity.id, val);
  return val;
}

/* ------------------------------------------------------------------ sign-in -- */

export type LoginState = "waiting" | "done" | "error" | "cancelled";

export interface LoginJobView {
  identityId: string;
  provider: string;
  state: LoginState;
  /** A sign-in page to open by hand; for Claude it ends on a code to paste. */
  url: string;
  /** Claude: the CLI also takes a pasted code. */
  acceptsCode: boolean;
  email: string;
  error: string;
  /** Signed in, but to an account another identity of this engine already uses. */
  duplicateOf: string;
  startedAt: number;
}

interface LoginJob extends LoginJobView {
  child: ChildProcess | null;
  out: string;
  timer: NodeJS.Timeout | null;
}

export type Spawner = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

const defaultSpawn: Spawner = (bin, args, env) => spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });

const jobs = new Map<string, LoginJob>();
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** The CLI's own sign-in command. Each opens the browser itself. */
export function loginArgs(provider: string): string[] {
  if (provider === "claude") return ["auth", "login", "--claudeai"];
  if (provider === "codex") return ["login"];
  if (provider === "grok-build") return ["login", "--oauth"];
  return [];
}

/** ANSI colour and OSC 8 hyperlink wrappers off, so a URL reads as one token. */
export function stripTerminal(text: string): string {
  return String(text || "")
    .replace(/\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The first sign-in URL the CLI printed. */
export function loginUrlFrom(provider: string, text: string): string {
  const t = stripTerminal(text);
  const re =
    provider === "claude"
      ? /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/\S*oauth\/authorize\S*/
      : provider === "codex"
        ? /https:\/\/auth\.openai\.com\/\S+/
        : /https:\/\/(?:auth\.x\.ai|accounts\.x\.ai|x\.ai)\/\S+/;
  const m = t.match(re);
  return m ? m[0].replace(/[)\].,;'"]+$/, "") : "";
}

function view(job: LoginJob): LoginJobView {
  const { child: _c, out: _o, timer: _t, ...rest } = job;
  return { ...rest };
}

export interface LoginDeps {
  spawnFn?: Spawner;
  run?: Runner;
  /** Other identities of the same engine, to flag "same account again". */
  others?: () => Promise<ReadonlyArray<{ id: string; label?: string; email?: string }>>;
  /** Persist the account email on the row once signed in. */
  onSignedIn?: (identityId: string, email: string) => Promise<void>;
}

function finish(job: LoginJob, state: LoginState, error = ""): void {
  job.state = state;
  job.error = error;
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  const child = job.child;
  job.child = null;
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}

async function settle(job: LoginJob, identity: IdentityLike, deps: LoginDeps): Promise<void> {
  invalidateOwnAuth(identity.id);
  const auth = await ownAuth(identity, { force: true, ...(deps.run ? { run: deps.run } : {}) }).catch(() => null);
  if (job.state === "cancelled") return;
  if (auth?.status === "signed_in") {
    job.email = auth.email;
    if (auth.email && deps.others) {
      const others = await deps.others().catch(() => []);
      const same = others.find((o) => o.id !== identity.id && o.email && o.email.toLowerCase() === auth.email.toLowerCase());
      if (same) job.duplicateOf = same.label || same.email || same.id;
    }
    if (deps.onSignedIn) await deps.onSignedIn(identity.id, auth.email).catch(() => {});
    finish(job, "done");
    return;
  }
  const tail = stripTerminal(job.out).replace(/https:\/\/\S+/g, "").trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(-240);
  finish(job, "error", tail || "Sign-in did not finish.");
}

/** Start (or return the running) browser sign-in for an isolated identity. */
export async function startLogin(identity: IdentityLike, deps: LoginDeps = {}): Promise<LoginJobView> {
  if (!identities.isIsolatedIdentity(identity)) {
    throw new Error("This login is this Mac's own; sign in to it from the engine's own app or terminal.");
  }
  const running = jobs.get(identity.id);
  if (running && running.state === "waiting") return view(running);
  const bin = binFor(identity.provider);
  if (!bin) throw new Error(`${identity.provider} is not installed on this Mac.`);
  const dir = identities.identityRuntimeDir(identity);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const job: LoginJob = {
    identityId: identity.id,
    provider: identity.provider,
    state: "waiting",
    url: "",
    acceptsCode: identity.provider === "claude",
    email: "",
    error: "",
    duplicateOf: "",
    startedAt: Date.now(),
    child: null,
    out: "",
    timer: null,
  };
  jobs.set(identity.id, job);
  const child = (deps.spawnFn || defaultSpawn)(bin, loginArgs(identity.provider), envFor(identity));
  job.child = child;
  const onData = (c: Buffer | string) => {
    job.out = (job.out + c.toString()).slice(-20_000);
    if (!job.url) job.url = loginUrlFrom(identity.provider, job.out);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => {
    if (job.state === "waiting") finish(job, "error", `Could not start sign-in: ${e.message}`);
  });
  child.on("close", () => {
    if (job.state !== "waiting") return;
    job.child = null;
    void settle(job, identity, deps);
  });
  job.timer = setTimeout(() => {
    if (job.state === "waiting") finish(job, "error", "Sign-in timed out. Start it again.");
  }, LOGIN_TIMEOUT_MS);
  job.timer.unref?.();
  // Hand back the URL once printed (claude prints it at once; the others may not).
  const until = Date.now() + 4_000;
  while (!job.url && job.state === "waiting" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return view(job);
}

export function loginStatus(identityId: string): LoginJobView | null {
  const job = jobs.get(identityId);
  return job ? view(job) : null;
}

export function loginActive(identityId: string): boolean {
  return jobs.get(identityId)?.state === "waiting";
}

/** Claude: paste the code from the sign-in page into the waiting CLI. */
export function submitLoginCode(identityId: string, code: unknown): LoginJobView {
  const job = jobs.get(identityId);
  const text = String(code || "").trim();
  if (!job || job.state !== "waiting" || !job.child?.stdin) throw new Error("No sign-in in progress. Start it again.");
  if (!job.acceptsCode) throw new Error("This sign-in finishes in the browser.");
  if (!text || /\s/.test(text) || text.length > 4096) throw new Error("Paste the code from the sign-in page.");
  job.child.stdin.write(`${text}\n`);
  return view(job);
}

export function cancelLogin(identityId: string): boolean {
  const job = jobs.get(identityId);
  if (!job || job.state !== "waiting") return false;
  finish(job, "cancelled");
  return true;
}

/** Forget a finished job (the UI has shown its result). */
export function clearLogin(identityId: string): void {
  const job = jobs.get(identityId);
  if (job && job.state !== "waiting") jobs.delete(identityId);
}

/**
 * Sign an ISOLATED identity out of its own login. Refuses the shared one:
 * that is the user's real login on this Mac, which Sub8 never signs out.
 */
export async function signOut(identity: IdentityLike, { run = defaultRun }: { run?: Runner } = {}): Promise<void> {
  if (!identities.isIsolatedIdentity(identity)) throw new Error("Sub8 does not sign this Mac's own login out.");
  cancelLogin(identity.id);
  const dir = identities.identityRuntimeDir(identity);
  const root = path.join(dataDir, "identities") + path.sep;
  if (!dir.startsWith(root)) throw new Error("Refusing a login directory outside Sub8's data.");
  if (!fsSync.existsSync(dir)) {
    invalidateOwnAuth(identity.id);
    return;
  }
  const bin = binFor(identity.provider);
  const env = envFor(identity);
  // The env carries this identity's dir, so the CLI only drops that login
  // (for Claude, the Keychain item suffixed with this dir's hash).
  if (bin && identity.provider === "claude") await run(bin, ["auth", "logout"], env, 20_000);
  if (bin && identity.provider === "codex") await run(bin, ["logout"], env, 20_000);
  if (bin && identity.provider === "grok-build") await run(bin, ["logout"], env, 20_000);
  if (identity.provider !== "claude") await fs.unlink(path.join(dir, "auth.json")).catch(() => {});
  invalidateOwnAuth(identity.id);
}

/** Remove an isolated identity's login directory (after signOut). Only under data/identities. */
export async function removeLoginDir(identity: IdentityLike): Promise<void> {
  if (!identities.isIsolatedIdentity(identity)) return;
  const dir = identities.identityRuntimeDir(identity);
  const root = path.join(dataDir, "identities") + path.sep;
  if (!dir.startsWith(root)) return;
  await fs.rm(dir, { recursive: true, force: true });
  const parent = path.dirname(dir);
  if (parent.startsWith(root)) await fs.rmdir(parent).catch(() => {});
  jobs.delete(identity.id);
  invalidateOwnAuth(identity.id);
}
