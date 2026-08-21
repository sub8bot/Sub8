import { createHash, randomBytes } from "node:crypto";

export const kind = "dummy";

export function sessionForEmail(email) {
  return {
    email,
    userId: `usr_${createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
    token: `dummy_${randomBytes(16).toString("hex")}`,
    expiresAt: null,
  };
}

export async function startMagic(email) {
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
