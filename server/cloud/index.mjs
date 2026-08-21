import { cloudBaseUrl, useMockAuth } from "./env.mjs";
import * as dummy from "./dummy.mjs";
import * as http from "./http.mjs";

export {
  accountEnabled,
  cloudBaseUrl,
  cloudFeaturesEnabled,
  cloudProductEnabled,
  isPackaged,
  requireAccount,
  useMockAuth,
} from "./env.mjs";

export function authBackend() {
  if (useMockAuth()) return dummy;
  return http;
}

function needBase() {
  const base = cloudBaseUrl();
  if (!base || base === "mock") {
    const err = new Error("Cloud sign-in is not configured.");
    err.code = "NO_CLOUD";
    throw err;
  }
  return base;
}

export async function startMagic(email) {
  const backend = authBackend();
  if (backend.kind === "dummy") return backend.startMagic(email);
  return backend.startMagic(email, { baseUrl: needBase() });
}

export async function startX() {
  const backend = authBackend();
  if (backend.kind === "dummy") return backend.startX();
  return backend.startX({ baseUrl: needBase() });
}

export async function waitX(state) {
  const backend = authBackend();
  if (backend.kind === "dummy") return { signedIn: true };
  return backend.waitX(state, { baseUrl: needBase() });
}
