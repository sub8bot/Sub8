import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./paths.mjs";
import { writeJsonAtomic } from "./store.mjs";
import {
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  requireAccount,
  startMagic as cloudStartMagic,
  startX as cloudStartX,
  waitX as cloudWaitX,
  useMockAuth,
} from "./cloud/index.mjs";

export {
  accountEnabled,
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  isPackaged,
  requireAccount,
  useMockAuth,
} from "./cloud/index.mjs";

export const accountPath = () => path.join(dataDir, "account.json");

export function normalizeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function blank() {
  return {
    version: 1,
    place: null,
    view: "local",
    inferred: false,
    cloudPromptDismissed: false,
    session: null,
    updatedAt: 0,
  };
}

function normalize(raw) {
  const base = blank();
  if (!raw || typeof raw !== "object") return base;
  const place = raw.place === "local" || raw.place === "cloud" ? raw.place : null;
  const rawSession = raw.session && typeof raw.session === "object" ? raw.session : null;
  const handle = String(rawSession?.handle || "").trim();
  const email = String(rawSession?.email || (handle ? `${handle}@x.local` : "")).trim();
  const token = String(rawSession?.token || "").trim();
  const session =
    rawSession && (email || handle || token)
      ? {
          email,
          handle,
          userId: String(rawSession.userId || ""),
          token,
          expiresAt: rawSession.expiresAt || null,
        }
      : null;
  const view = raw.view === "cloud" || raw.view === "local" ? raw.view : place === "cloud" ? "cloud" : "local";
  return {
    version: 1,
    place,
    view: view === "cloud" && !session ? "local" : view,
    inferred: Boolean(raw.inferred),
    cloudPromptDismissed: Boolean(raw.cloudPromptDismissed),
    session,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export function sessionLive(session, now = Date.now()) {
  if (!session?.token && !session?.email && !session?.handle) return false;
  if (session.expiresAt && Number(session.expiresAt) <= now) return false;
  return true;
}

export function decideGate(row, { requireAccount: must, hasLocalBots } = {}) {
  const force = must === true;
  const signedIn = sessionLive(row?.session);
  let place = row?.place || null;
  let inferred = Boolean(row?.inferred);
  if (!place && hasLocalBots) {
    place = "local";
    inferred = true;
  }
  const needsChoice = !place || (place === "cloud" && !signedIn);
  const hideLocal = force && !place && !hasLocalBots;
  const ready = place === "local" || (place === "cloud" && signedIn);
  const view = signedIn && row?.view === "cloud" ? "cloud" : "local";
  const needsCloudPrompt =
    ready && place === "local" && !signedIn && !row?.cloudPromptDismissed && !needsChoice;
  return {
    ready,
    needsChoice,
    needsCloudPrompt,
    requireAccount: force,
    hideLocal,
    place,
    view,
    signedIn,
    inferred,
    cloudEnabled: signedIn,
    cloudPromptDismissed: Boolean(row?.cloudPromptDismissed),
    email: signedIn ? row.session.email : null,
    handle: signedIn ? row.session.handle || null : null,
    userId: signedIn ? row.session.userId || null : null,
  };
}

export function disabledAccount() {
  return {
    enabled: false,
    ready: true,
    needsChoice: false,
    needsCloudPrompt: false,
    requireAccount: false,
    hideLocal: false,
    place: "local",
    view: "local",
    signedIn: false,
    inferred: false,
    cloudEnabled: false,
    cloudPromptDismissed: true,
    email: null,
    handle: null,
    userId: null,
    mockAuth: false,
    cloudConfigured: false,
    comingSoon: false,
    cloudProduct: false,
    xLogin: false,
  };
}

export function publicAccount(row, opts = {}) {
  if (!cloudFeaturesEnabled()) return disabledAccount();
  const gate = decideGate(row, opts);
  const product = cloudProductEnabled();
  const comingSoon = !product;
  if (comingSoon) {
    gate.needsChoice = false;
    gate.needsCloudPrompt = false;
    gate.ready = true;
    gate.hideLocal = false;
    gate.view = "local";
  }
  return {
    ...gate,
    enabled: true,
    comingSoon,
    cloudProduct: product,
    handle: gate.signedIn ? row?.session?.handle || null : null,
    mockAuth: useMockAuth(),
    cloudConfigured: Boolean(cloudBaseUrl()) && cloudBaseUrl() !== "mock",
    xLogin: !useMockAuth(),
  };
}

export async function loadAccount({ hasLocalBots = false } = {}) {
  let row = blank();
  try {
    row = normalize(JSON.parse(await fs.readFile(accountPath(), "utf8")));
  } catch {
    row = blank();
  }
  if (!row.place && hasLocalBots) {
    row = { ...blank(), place: "local", view: "local", inferred: true, cloudPromptDismissed: false, updatedAt: Date.now() };
    await saveAccount(row);
  }
  return row;
}

export async function saveAccount(row) {
  const next = normalize({ ...row, updatedAt: Date.now() });
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonAtomic(accountPath(), next);
  return next;
}

export async function chooseLocal() {
  if (requireAccount()) {
    const err = new Error("This build requires a Sub8 account.");
    err.code = "ACCOUNT_REQUIRED";
    throw err;
  }
  const prev = await loadAccount();
  return saveAccount({
    ...prev,
    place: "local",
    view: "local",
    inferred: false,
    cloudPromptDismissed: true,
    session: prev.session,
  });
}

export async function dismissCloudPrompt() {
  const prev = await loadAccount();
  return saveAccount({ ...prev, cloudPromptDismissed: true });
}

export async function setView(view) {
  const next = view === "cloud" ? "cloud" : "local";
  const prev = await loadAccount();
  if (next === "cloud" && !cloudProductEnabled()) {
    const err = new Error("Cloud desks are coming soon.");
    err.code = "CLOUD_SOON";
    throw err;
  }
  if (next === "cloud" && !sessionLive(prev.session)) {
    const err = new Error("Sign in to open Cloud.");
    err.code = "SIGN_IN";
    throw err;
  }
  return saveAccount({ ...prev, view: next, place: next === "cloud" ? "cloud" : prev.place || "local" });
}

export async function signInMock(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    const err = new Error("Enter a valid email.");
    err.code = "BAD_EMAIL";
    throw err;
  }
  if (!useMockAuth()) {
    const err = new Error("Cloud sign-in is not configured.");
    err.code = "NO_CLOUD";
    throw err;
  }
  const started = await cloudStartMagic(email);
  if (!started.session) {
    const err = new Error("Cloud sign-in is not configured.");
    err.code = "NO_CLOUD";
    throw err;
  }
  return saveAccount({
    place: "cloud",
    view: "cloud",
    inferred: false,
    cloudPromptDismissed: true,
    session: started.session,
  });
}

export async function startMagic(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!email) {
    const err = new Error("Enter a valid email.");
    err.code = "BAD_EMAIL";
    throw err;
  }
  const started = await cloudStartMagic(email);
  if (started.session) {
    const row = await saveAccount({
      place: "cloud",
      view: "cloud",
      inferred: false,
      cloudPromptDismissed: true,
      session: started.session,
    });
    return { ok: true, mock: true, signedIn: true, email: row.session.email };
  }
  return { ok: true, mock: false, signedIn: false, email };
}

export async function completeSession(payload) {
  const handle = String(payload?.handle || "").trim();
  const email = normalizeEmail(payload?.email) || (handle ? `${handle.toLowerCase()}@x.local` : "");
  const token = String(payload?.token || "").trim();
  const userId = String(payload?.userId || "").trim() || randomUUID();
  if ((!email && !handle) || !token) {
    const err = new Error("Sign-in did not finish.");
    err.code = "BAD_SESSION";
    throw err;
  }
  return saveAccount({
    place: cloudProductEnabled() ? "cloud" : "local",
    view: cloudProductEnabled() ? "cloud" : "local",
    inferred: false,
    cloudPromptDismissed: true,
    session: {
      email,
      handle,
      userId,
      token,
      expiresAt: payload?.expiresAt || null,
    },
  });
}

const xPumps = new Map();

function pumpXWait(state) {
  const raw = String(state || "").trim();
  if (!raw || xPumps.has(raw)) return;
  const run = (async () => {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const local = await loadAccount();
        if (sessionLive(local.session)) return;
        const row = await cloudWaitX(raw);
        if (row?.signedIn && row.token) {
          await completeSession(row);
          return;
        }
        if (row?.error && row.error !== "unknown state" && !row.signedIn) return;
      } catch {
        /* Browser is often focused on x.com; keep polling from Node. */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  })();
  xPumps.set(raw, run);
  run.finally(() => xPumps.delete(raw));
}

export async function startX() {
  const started = await cloudStartX();
  if (started.session) {
    const row = await saveAccount({
      place: cloudProductEnabled() ? "cloud" : "local",
      view: cloudProductEnabled() ? "cloud" : "local",
      inferred: false,
      cloudPromptDismissed: true,
      session: started.session,
    });
    return {
      ok: true,
      mock: true,
      signedIn: true,
      email: row.session.email,
      handle: row.session.handle || "",
    };
  }
  if (started.state) pumpXWait(started.state);
  return {
    ok: true,
    mock: false,
    signedIn: false,
    authorizeUrl: started.authorizeUrl,
    state: started.state,
  };
}

export async function waitX(state) {
  const raw = String(state || "").trim();
  if (!raw) {
    const err = new Error("Missing sign-in state.");
    err.code = "BAD_SESSION";
    throw err;
  }
  const local = await loadAccount();
  if (sessionLive(local.session)) return { signedIn: true };
  const row = await cloudWaitX(raw);
  if (row?.error && row.error !== "unknown state" && !row.signedIn) {
    const err = new Error(row.error);
    err.code = "CLOUD";
    throw err;
  }
  if (!row.signedIn || !row.token) return { signedIn: false };
  await completeSession(row);
  return { signedIn: true };
}

export async function logout() {
  const must = requireAccount();
  const prev = await loadAccount();
  return saveAccount({
    ...prev,
    place: must ? null : "local",
    view: "local",
    inferred: false,
    session: null,
  });
}
