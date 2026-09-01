export const kind = "http";

/**
 * What this module reads off a Cloud JSON body. Open on purpose: waitX hands
 * its body back to the caller whole, so a closed shape would be a claim the
 * API does not honour.
 */
export interface CloudBody {
  error?: string | undefined;
  detail?: string | undefined;
  code?: string | undefined;
  billingUrl?: string | undefined;
  sku?: string | undefined;
  used?: unknown;
  entitled?: unknown;
  unitAmountCents?: unknown;
  signedIn?: boolean | undefined;
  token?: string | undefined;
  email?: string | undefined;
  userId?: string | undefined;
  expiresAt?: string | null | undefined;
  authorizeUrl?: string | undefined;
  state?: string | undefined;
  [key: string]: unknown;
}

/**
 * The Error this module throws: a plain Error with the Cloud fields stapled on,
 * which the desktop UI reads back off `err.code` / `err.billingUrl`. An
 * interface plus `new Error(...) as CloudError`, not a subclass: a subclass
 * would change the thrown value's prototype. The assertion emits nothing.
 */
export interface CloudError extends Error {
  code?: string | undefined;
  status?: number | undefined;
  billingUrl?: string | undefined;
  sku?: string | undefined;
  used?: unknown;
  entitled?: unknown;
  unitAmountCents?: unknown;
}

/** Options every call in this module accepts. */
export interface CloudOptions {
  baseUrl?: string | undefined;
}

/**
 * cloudApi's fetch init is asserted `as RequestInit`: RequestInit declares
 * `body?: BodyInit | null` with no `| undefined`, so under
 * exactOptionalPropertyTypes the explicit undefined it has always passed is an
 * error against a lib type we do not own. fetch cannot tell an absent body
 * from an undefined one.
 */
export interface CloudApiOptions extends CloudOptions {
  token?: string | undefined;
  method?: string | undefined;
  body?: unknown;
}

function apiError(res: Response, json: CloudBody, fallback: string): CloudError {
  const err = new Error((json && (json.error || json.detail)) || fallback) as CloudError;
  err.code = (json && json.code) || "CLOUD";
  err.status = res.status;
  if (json && json.billingUrl) err.billingUrl = json.billingUrl;
  if (json && json.sku) err.sku = json.sku;
  if (json && json.used != null) err.used = json.used;
  if (json && json.entitled != null) err.entitled = json.entitled;
  if (json && json.unitAmountCents != null) err.unitAmountCents = json.unitAmountCents;
  return err;
}

async function readJson(res: Response): Promise<CloudBody> {
  try {
    return (await res.json()) as CloudBody;
  } catch {
    return {};
  }
}

function waitlistError(): CloudError {
  const err = new Error("You're on the list. Always-on Cloud desks are not shipping yet. This Mac keeps working.") as CloudError;
  err.code = "WAITLIST";
  err.status = 403;
  return err;
}

/**
 * Revoke the session server-side. Best-effort by contract: the local sign-out
 * must complete even if the Worker is unreachable, so the caller swallows the
 * throw -- a token that outlives its sign-out is the bug being fixed, but a
 * user unable to sign out at all would be a worse one.
 */
export async function revokeSession(token: string, { baseUrl }: CloudOptions = {}) {
  return cloudApi("/auth/logout", { baseUrl, token, method: "POST", body: {} });
}

export async function startMagic(email: string, { baseUrl }: CloudOptions = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/auth/magic`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, client: "sub8-desktop" }),
  });
  const json = await readJson(res);
  if (res.status === 403) throw waitlistError();
  if (!res.ok) throw apiError(res, json, `Sign-in failed (${res.status})`);
  if (json.signedIn && json.token) {
    return {
      mock: false,
      signedIn: true,
      email,
      session: {
        token: json.token,
        email: json.email || email,
        userId: json.userId,
        expiresAt: json.expiresAt,
      },
    };
  }
  return { mock: false, signedIn: false, email };
}

export async function startX({ baseUrl }: CloudOptions = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  // ?code=1: the cloud shows a confirm page after X consent that asks for the
  // code we display, so a sign-in only completes for the app the user is
  // looking at (the pickup token is never released on the state alone).
  const res = await fetch(`${base}/auth/x/start?code=1`, { headers: { Accept: "application/json" } });
  const json = await readJson(res);
  if (!res.ok) throw apiError(res, json, `X sign-in failed (${res.status})`);
  if (!json.authorizeUrl || !json.state) {
    const err = new Error("X sign-in did not return an authorize URL.") as CloudError;
    err.code = "CLOUD";
    throw err;
  }
  return { authorizeUrl: json.authorizeUrl, state: json.state, code: json.code ? String(json.code) : "", signedIn: false, mock: false };
}

export async function waitX(state?: string | null, { baseUrl }: CloudOptions = {}): Promise<CloudBody> {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/x/wait?state=${encodeURIComponent(state || "")}`;
  const res = await fetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-store" } });
  const json = await readJson(res);
  if (res.status === 404) return { signedIn: false };
  if (!res.ok) {
    if (res.status === 400) return { signedIn: false, error: json.error };
    throw apiError(res, json, `X wait failed (${res.status})`);
  }
  return json;
}

export async function cloudApi(path: string, { baseUrl, token, method = "GET", body }: CloudApiOptions = {}): Promise<CloudBody> {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  } as RequestInit);
  const json = await readJson(res);
  if (!res.ok) throw apiError(res, json, `Cloud ${res.status}`);
  return json;
}
