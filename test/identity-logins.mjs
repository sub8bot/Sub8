/**
 * Separate logins per identity (several accounts of one engine on this Mac).
 *
 * The defect: "+ Add login" made an "isolated" Claude row that instantly said
 * "Signed in · This Mac's login", because its status was read from the Mac's
 * default login and nothing ever signed it in. These pin: each isolated
 * identity's CLI env points at its own login dir, its status comes from that
 * dir only, a new login walks through its own sign-in, the shared login is
 * never signed out, and only empty, unused rows are offered for cleanup.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sub8-identity-logins-"));
process.env.SUB8BOT_DATA = tmp;
process.env.OCTOBOT_DATA = tmp;

const identities = await import("../server/identities.mjs");
const auth = await import("../server/identity-auth.mjs");
const { turnIdentity, writeCodexHome } = await import("../server/host-cli.mjs");
const rows = await import("../web/identity-rows.mjs");

const host = { id: "id-claude-host", provider: "claude", place: "local", runtimeRef: "host", label: "Claude", subject: "", kind: "cli-oauth", model: "", createdAt: 1, updatedAt: 1 };
const a = { ...host, id: "aaaa-1111", runtimeRef: "aaaa-1111" };
const b = { ...host, id: "bbbb-2222", runtimeRef: "bbbb-2222" };

/* ---------------------------------------------------------- isolation (env) -- */
{
  const dirA = identities.identityRuntimeDir(a);
  const dirB = identities.identityRuntimeDir(b);
  assert.notEqual(dirA, dirB, "two identities, two login dirs");
  assert.ok(dirA.startsWith(path.join(tmp, "identities")));
  assert.deepEqual(identities.identityCliEnv(a), { CLAUDE_CONFIG_DIR: dirA });
  assert.deepEqual(identities.identityCliEnv(host), {}, "the shared login keeps the Mac's env");

  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/somewhere/else" };
  const envA = identities.applyIdentityEnv(base, a);
  assert.equal(envA.CLAUDE_CONFIG_DIR, dirA);
  assert.equal(envA.ANTHROPIC_API_KEY, undefined, "an inherited key would shadow the identity's login");
  assert.equal(envA.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(identities.applyIdentityEnv(base, host), base, "shared login: env untouched");

  const codex = { ...a, provider: "codex" };
  const grok = { ...a, provider: "grok-build" };
  assert.deepEqual(Object.keys(identities.identityCliEnv(codex)), ["CODEX_HOME"]);
  assert.deepEqual(Object.keys(identities.identityCliEnv(grok)), ["GROK_HOME"]);
  assert.equal(identities.isIsolatedIdentity({ ...a, provider: "cursor" }), false, "Cursor keeps one login per Mac");
  assert.equal(identities.isIsolatedIdentity({ ...a, place: "cloud" }), false);

  // The turn's identity only applies to the same engine.
  const attachB = { identityId: b.id, runtimeRef: b.runtimeRef, provider: "claude", place: "local" };
  const t = turnIdentity(attachB, "claude");
  assert.equal(t?.id, b.id);
  assert.equal(identities.applyIdentityEnv({}, t).CLAUDE_CONFIG_DIR, dirB, "bot on identity B spawns with B's dir");
  assert.equal(turnIdentity(attachB, "grok-build"), null);
  assert.equal(turnIdentity({ identityId: host.id, runtimeRef: "host", provider: "claude" }, "claude"), null);

  // Codex: the turn's CODEX_HOME shares the identity's auth.json, not the Mac's.
  const work = await fs.mkdtemp(path.join(tmp, "work-"));
  const idAuth = path.join(identities.identityRuntimeDir(codex), "auth.json");
  await fs.mkdir(path.dirname(idAuth), { recursive: true });
  await fs.writeFile(idAuth, "{}");
  const home = await writeCodexHome(work, {}, idAuth);
  assert.equal(await fs.readlink(path.join(home, "auth.json")), idAuth);
}

/* ------------------------------------------------------------ status parsing -- */
{
  const on = auth.parseClaudeOwnStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "b@example.com" }));
  assert.deepEqual(on, { status: "signed_in", email: "b@example.com", ownCredentials: true });
  const off = auth.parseClaudeOwnStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }));
  assert.deepEqual(off, { status: "signed_out", email: "", ownCredentials: false });
  assert.equal(auth.parseClaudeOwnStatus("spawn claude ENOENT").ownCredentials, null, "unknown is never 'no credentials'");

  const jwt = `x.${Buffer.from(JSON.stringify({ email: "c@example.com" })).toString("base64url")}.y`;
  assert.deepEqual(auth.parseCodexAuth({ tokens: { id_token: jwt, refresh_token: "r" } }), { signedIn: true, email: "c@example.com" });
  assert.deepEqual(auth.parseCodexAuth({}), { signedIn: false, email: "" });
  assert.deepEqual(auth.parseGrokAuth({ "https://auth.x.ai::id": { refresh_token: "r", email: "g@example.com" } }), { signedIn: true, email: "g@example.com" });
  assert.deepEqual(auth.parseGrokAuth({}), { signedIn: false, email: "" });

  const osc = "If the browser didn't open, visit: \u001b]8;;https://claude.com/cai/oauth/authorize?code=true&state=s\u0007https://claude.com/cai/oauth/authorize?code=true&state=s\u001b]8;;\u0007\nPaste code here if prompted >";
  assert.equal(auth.loginUrlFrom("claude", osc), "https://claude.com/cai/oauth/authorize?code=true&state=s");

  // An isolated row never reads the Mac's login; it reads its own.
  const probe = { harnesses: { claude: { id: "claude", installed: true, signedIn: true, ready: true, extra: { email: "mac@example.com" } } } };
  const dA = identities.decorateIdentity(a, probe, null);
  assert.equal(dA.status, "signed_out", "the bug: this said Signed in off the Mac's login");
  assert.equal(dA.email, "");
  assert.equal(identities.decorateIdentity(a, probe, { status: "signed_in", email: "a@example.com", ownCredentials: true }).email, "a@example.com");
  const dHost = identities.decorateIdentity(host, probe, null);
  assert.equal(dHost.status, "signed_in");
  assert.equal(dHost.email, "mac@example.com");

  // No login dir yet = signed out, without spawning the CLI.
  let ran = 0;
  const fresh = await auth.probeOwnAuth({ ...a, id: "never", runtimeRef: "never" }, { run: async () => (ran++, { code: 0, out: "" }) });
  assert.equal(fresh.status, "signed_out");
  assert.equal(fresh.ownCredentials, false);
  assert.equal(ran, 0);
  // With a dir, the probe runs `claude auth status` under that dir only.
  await fs.mkdir(identities.identityRuntimeDir(a), { recursive: true });
  let seen = null;
  const st = await auth.probeOwnAuth(a, {
    run: async (bin, args, env) => {
      seen = { args, dir: env.CLAUDE_CONFIG_DIR };
      return { code: 0, out: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@example.com" }) };
    },
  });
  assert.deepEqual(seen, { args: ["auth", "status"], dir: identities.identityRuntimeDir(a) });
  assert.equal(st.email, "a@example.com");
}

/* ------------------------------------------------------ add-then-sign-in flow -- */
{
  function fakeChild() {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    c.exitCode = null;
    c.killed = false;
    c.kill = () => {
      c.killed = true;
      return true;
    };
    return c;
  }
  const child = fakeChild();
  let spawned = null;
  let saved = null;
  const typed = [];
  child.stdin.on("data", (d) => typed.push(String(d)));
  let loggedIn = false;
  const deps = {
    spawnFn: (bin, args, env) => {
      spawned = { args, dir: env.CLAUDE_CONFIG_DIR };
      setTimeout(() => child.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > "), 10);
      return child;
    },
    run: async () => ({ code: 0, out: JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "claude.ai", email: "a@example.com" } : { loggedIn: false, authMethod: "none" }) }),
    others: async () => [{ id: host.id, label: "Claude", email: "mac@example.com" }],
    onSignedIn: async (id, email) => {
      saved = { id, email };
    },
  };
  await assert.rejects(auth.startLogin(host, deps), /this Mac/, "the shared login is not Sub8's to sign in or out");

  const job = await auth.startLogin(b, deps);
  assert.equal(job.state, "waiting");
  assert.equal(job.acceptsCode, true);
  assert.match(job.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.deepEqual(spawned, { args: ["auth", "login", "--claudeai"], dir: identities.identityRuntimeDir(b) });
  assert.equal(auth.loginActive(b.id), true);
  assert.equal((await auth.startLogin(b, deps)).state, "waiting", "a second click reuses the running sign-in");

  assert.throws(() => auth.submitLoginCode(b.id, ""), /Paste the code/);
  auth.submitLoginCode(b.id, "abc#def");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(typed, ["abc#def\n"]);

  loggedIn = true;
  child.emit("close", 0);
  for (let i = 0; i < 50 && auth.loginStatus(b.id)?.state === "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
  const done = auth.loginStatus(b.id);
  assert.equal(done.state, "done");
  assert.equal(done.email, "a@example.com");
  assert.equal(done.duplicateOf, "", "a different account than the Mac's");
  assert.deepEqual(saved, { id: b.id, email: "a@example.com" });
  assert.equal(auth.loginActive(b.id), false);

  // Same account as another row: flagged so the user can retry with another one.
  const child2 = fakeChild();
  const deps2 = { ...deps, spawnFn: () => child2, others: async () => [{ id: a.id, label: "Claude · a@example.com", email: "A@example.com" }] };
  const c = { ...host, id: "cccc-3333", runtimeRef: "cccc-3333" };
  await auth.startLogin(c, deps2);
  child2.emit("close", 0);
  for (let i = 0; i < 50 && auth.loginStatus(c.id)?.state === "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(auth.loginStatus(c.id).duplicateOf, "Claude · a@example.com");

  // Cancel kills the waiting CLI.
  const child3 = fakeChild();
  const d = { ...host, id: "dddd-4444", runtimeRef: "dddd-4444" };
  await auth.startLogin(d, { ...deps, spawnFn: () => child3 });
  assert.equal(auth.cancelLogin(d.id), true);
  assert.equal(child3.killed, true);
  assert.equal(auth.loginStatus(d.id).state, "cancelled");

  // Sign-out: only an isolated login, and only under its own dir.
  await assert.rejects(auth.signOut(host, { run: async () => ({ code: 0, out: "" }) }), /does not sign/);
  let logout = null;
  await auth.signOut(b, { run: async (bin, args, env) => ((logout = { args, dir: env.CLAUDE_CONFIG_DIR }), { code: 0, out: "" }) });
  assert.deepEqual(logout, { args: ["auth", "logout"], dir: identities.identityRuntimeDir(b) });
}

/* ------------------------------------------------------------- cleanup rules -- */
{
  const now = 10 * 60_000;
  const mk = (id, extra = {}) => ({ ...host, id, runtimeRef: id, createdAt: 0, ...extra });
  const all = [host, mk("empty"), mk("withbot"), mk("signed"), mk("unknown"), mk("busy"), mk("new", { createdAt: now - 1000 }), mk("cur", { provider: "cursor" })];
  const facts = {
    "id-claude-host": { ownCredentials: false },
    empty: { ownCredentials: false },
    withbot: { ownCredentials: false },
    signed: { ownCredentials: true },
    unknown: { ownCredentials: null },
    busy: { ownCredentials: false, loginActive: true },
    new: { ownCredentials: false },
    cur: { ownCredentials: false },
  };
  const got = identities.cleanupCandidates(all, facts, [{ identityId: "withbot" }], { now }).map((r) => r.id);
  assert.deepEqual(got, ["empty"], "never the shared login, a bot's, one with credentials, an unknown, a running or brand-new sign-in");
}

/* ------------------------------------------------------- add only where real -- */
{
  await assert.rejects(identities.addIdentity({ provider: "cursor", isolated: true }), /one login per Mac/);
  const row = await identities.addIdentity({ provider: "claude", isolated: true });
  assert.equal(row.runtimeRef, row.id);
  assert.equal(row.subject, "", "a new login starts signed out, with no borrowed account");
  assert.equal(identities.isIsolatedIdentity(row), true);
}

/* ---------------------------------------------------------------- UI rows -- */
{
  const sep = { id: "x", label: "Claude", provider: "claude", place: "local", runtimeRef: "x", separate: true, status: "signed_out" };
  assert.equal(rows.identityOptionLabel(sep), "Claude · not signed in");
  assert.equal(rows.identityOptionLabel({ ...sep, status: "signed_in", email: "b@example.com" }), "Claude · b@example.com");
  assert.equal(rows.identityOptionLabel({ ...sep, runtimeRef: "host", separate: false, status: "signed_in", email: "mac@example.com" }), "Claude · mac@example.com");
  const html = rows.identityRowHtml(sep);
  assert.match(html, /data-act="identity-login"/);
  assert.match(html, /data-act="identity-remove"/);
  assert.match(html, /Not signed in yet/);
  const signed = rows.identityRowHtml({ ...sep, status: "signed_in", email: "b@example.com" });
  assert.match(signed, /b@example\.com/);
  assert.match(signed, /data-act="identity-logout"/);
  const shared = rows.identityRowHtml({ ...sep, runtimeRef: "host", separate: false, status: "signed_in", email: "mac@example.com" });
  assert.doesNotMatch(shared, /identity-logout|identity-remove/, "the Mac's own login is never signed out from Sub8");
  const waiting = rows.identityRowHtml({ ...sep, login: { state: "waiting", url: "https://claude.com/cai/oauth/authorize?x=1", acceptsCode: true } });
  assert.match(waiting, /identity-login-open/);
  assert.match(waiting, /data-identity-code="x"/);
  assert.doesNotMatch(rows.identityRowHtml({ ...sep, login: { state: "waiting", url: "javascript:alert(1)" } }), /javascript:/);
  assert.match(rows.cleanupBannerHtml(3), /3 logins were added but never signed in/);
  assert.equal(rows.cleanupBannerHtml(0), "");
}

await fs.rm(tmp, { recursive: true, force: true });
console.log("identity-logins: ok");
process.exit(0);
