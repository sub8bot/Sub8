export const kind = "http";

function apiError(res, json, fallback) {
  const err = new Error((json && (json.error || json.detail)) || fallback);
  err.code = "CLOUD";
  err.status = res.status;
  return err;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function startMagic(email, { baseUrl } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/auth/magic`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, client: "sub8-desktop" }),
  });
  const json = await readJson(res);
  if (!res.ok) throw apiError(res, json, `Sign-in failed (${res.status})`);
  return { mock: false, signedIn: false, email };
}

export async function startX({ baseUrl } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}/auth/x/start`, { headers: { Accept: "application/json" } });
  const json = await readJson(res);
  if (!res.ok) throw apiError(res, json, `X sign-in failed (${res.status})`);
  if (!json.authorizeUrl || !json.state) {
    const err = new Error("X sign-in did not return an authorize URL.");
    err.code = "CLOUD";
    throw err;
  }
  return { authorizeUrl: json.authorizeUrl, state: json.state, signedIn: false, mock: false };
}

export async function waitX(state, { baseUrl } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/auth/x/wait?state=${encodeURIComponent(state || "")}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await readJson(res);
  if (res.status === 404) return { signedIn: false, error: json.error || "unknown state" };
  if (!res.ok) throw apiError(res, json, `X wait failed (${res.status})`);
  return json;
}
