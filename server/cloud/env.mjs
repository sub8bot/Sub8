const DEFAULT_CLOUD_URL = "https://sub8.bot";

/** Sub8 account + Sign in with X. Off only when SUB8_ACCOUNT=0. */
export function accountEnabled() {
  return process.env.SUB8_ACCOUNT !== "0";
}

/** Always-on Cloud desks. Off → login still works; UI says coming soon. */
export function cloudProductEnabled() {
  return process.env.SUB8_CLOUD === "1";
}

export function cloudFeaturesEnabled() {
  return accountEnabled();
}

export function requireAccount() {
  return accountEnabled() && process.env.SUB8_REQUIRE_ACCOUNT === "1";
}

export function cloudBaseUrl() {
  const raw = String(process.env.SUB8_CLOUD_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (raw) return raw;
  if (!accountEnabled()) return "";
  return DEFAULT_CLOUD_URL;
}

export function isPackaged() {
  return process.env.SUB8_PACKAGED === "1";
}

export function useMockAuth() {
  if (!accountEnabled()) return false;
  const raw = String(process.env.SUB8_CLOUD_URL || "").trim();
  if (raw === "mock") return true;
  if (process.env.SUB8_MOCK_AUTH === "1") return true;
  return false;
}
