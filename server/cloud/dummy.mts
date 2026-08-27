import { createHash, randomBytes } from "node:crypto";

/**
 * The mock session the offline/dev path hands back, shaped like the real one
 * cloud/http.mts builds. `handle` is optional because only startX sets it, and
 * it does so by assignment after sessionForEmail has already returned.
 */
export interface DummySession {
  email: string;
  userId: string;
  token: string;
  expiresAt: string | null;
  handle?: string | undefined;
}

export const kind = "dummy";

export function sessionForEmail(email: string): DummySession {
  return {
    email,
    userId: `usr_${createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
    token: `dummy_${randomBytes(16).toString("hex")}`,
    expiresAt: null,
  };
}

export async function startMagic(email: string) {
  return {
    mock: true,
    signedIn: true,
    email,
    session: sessionForEmail(email),
  };
}

export async function startX() {
  const session = sessionForEmail("dev@x.local");
  session.handle = "dev";
  return { mock: true, signedIn: true, session, authorizeUrl: "", state: "dummy" };
}

export async function waitX() {
  return { signedIn: true };
}
