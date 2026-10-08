/**
 * Settings → Harnesses login rows, and the bot Identity dropdown labels.
 *
 * Two kinds of local login: the shared one ("This Mac's login", the CLI's
 * default) and separate ones Sub8 keeps in their own directory so a second
 * account of the same engine can be signed in at the same time.
 */

/** Engines that can hold a separate login on this Mac. */
export const SEPARATE_LOGIN_PROVIDERS = ["claude", "codex", "grok-build"];

export interface IdentityLoginView {
  state: "waiting" | "done" | "error" | "cancelled";
  url?: string;
  acceptsCode?: boolean;
  email?: string;
  error?: string;
  duplicateOf?: string;
}

export interface IdentityRowView {
  id: string;
  label: string;
  provider: string;
  place?: string;
  runtimeRef?: string;
  subject?: string;
  status?: string;
  email?: string;
  separate?: boolean;
  login?: IdentityLoginView | null;
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  "grok-build": "Grok Build",
  cursor: "Cursor",
  hermes: "Hermes",
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function httpUrl(value: unknown): string {
  const s = String(value || "").trim();
  return /^https:\/\//i.test(s) ? s : "";
}

export function isSeparateRow(row: Pick<IdentityRowView, "separate" | "runtimeRef" | "place">): boolean {
  if (typeof row.separate === "boolean") return row.separate;
  const ref = String(row.runtimeRef || "");
  return row.place !== "cloud" && Boolean(ref) && ref !== "host";
}

/** The account a row is signed in as, or what it is when there is no email. */
export function identityWho(row: IdentityRowView): string {
  const email = String(row.email || "").trim();
  if (row.status === "signed_in") return email || (isSeparateRow(row) ? "Signed in" : "This Mac’s login");
  if (row.status === "expired") return email ? `${email} (expired)` : "Session expired";
  return isSeparateRow(row) ? "Not signed in yet" : email || "Not signed in";
}

/** One option of the bot settings Identity dropdown: engine · account. */
export function identityOptionLabel(row: IdentityRowView): string {
  const name = PROVIDER_NAMES[row.provider] || String(row.label || "").split(" · ")[0] || row.provider;
  const email = String(row.email || "").trim();
  if (!isSeparateRow(row)) return `${name} · ${email || "This Mac’s login"}`;
  if (row.status === "signed_in") return `${name} · ${email || "separate login"}`;
  if (row.status === "expired") return `${name} · ${email || "separate login"} (expired)`;
  return `${name} · not signed in`;
}

/** The sign-in panel under a row while its browser sign-in runs (or just finished). */
export function identityLoginPanelHtml(row: IdentityRowView, { busy = false }: { busy?: boolean } = {}): string {
  const job = row.login;
  if (!job || job.state === "cancelled") return "";
  const id = esc(row.id);
  if (job.state === "done") {
    const who = job.email ? `Signed in as ${esc(job.email)}.` : "Signed in.";
    const dup = job.duplicateOf
      ? `<div class="sub" style="color:var(--danger)">That is the same account as ${esc(job.duplicateOf)}. To use another account, sign this login out, sign out of ${esc(
          PROVIDER_NAMES[row.provider] || row.provider,
        )} in your browser (or use a private window), and sign in again.</div>`
      : "";
    return `<div class="ident-login" data-id="${id}"><div class="sub">${who}</div>${dup}<div class="row" style="gap:8px"><button type="button" class="pill" data-act="identity-login-dismiss" data-id="${id}">OK</button></div></div>`;
  }
  if (job.state === "error") {
    return `<div class="ident-login" data-id="${id}"><div class="sub" style="color:var(--danger)">${esc(job.error || "Sign-in did not finish.")}</div><div class="row" style="gap:8px"><button type="button" class="pill primary" data-act="identity-login" data-id="${id}">Try again</button><button type="button" class="pill" data-act="identity-login-dismiss" data-id="${id}">Close</button></div></div>`;
  }
  const url = httpUrl(job.url);
  const name = PROVIDER_NAMES[row.provider] || row.provider;
  const code = job.acceptsCode
    ? `<div class="sub">If the page shows a code instead, paste it here.</div>
      <div class="row" style="gap:8px">
        <input class="field" id="identity-code-${id}" data-identity-code="${id}" type="text" autocomplete="off" placeholder="Paste code" ${busy ? "disabled" : ""} />
        <button type="button" class="pill primary" data-act="identity-code-submit" data-id="${id}" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Continue"}</button>
      </div>`
    : "";
  return `<div class="ident-login" data-id="${id}">
      <div class="sub">Sign in to ${esc(name)} in the browser with the account this login should use. If the browser is already signed in to another ${esc(
        name,
      )} account, sign out there first or open the link below in a private window.</div>
      <div class="row" style="gap:8px">${url ? `<button type="button" class="pill" data-act="identity-login-open" data-id="${id}" data-url="${esc(url)}">Open sign-in page</button>` : ""}<button type="button" class="pill" data-act="identity-login-cancel" data-id="${id}">Cancel</button></div>
      ${code}
    </div>`;
}

/** One login inside a harness card: who, where, which bots, and its actions. */
export function identityRowHtml(row: IdentityRowView, { usedBy = [] as string[], busy = false } = {}): string {
  const tone = row.status === "signed_in" ? "ok" : row.status === "expired" || row.status === "not_installed" ? "bad" : "warn";
  const separate = isSeparateRow(row);
  const scope = separate ? "separate login" : "this Mac’s login";
  const bots = usedBy.length ? ` · used by ${usedBy.map(esc).join(", ")}` : " · no bots yet";
  const waiting = row.login?.state === "waiting";
  const status =
    row.status === "signed_in" ? "Signed in" : row.status === "expired" ? "Session expired" : row.status === "not_installed" ? "Not installed" : waiting ? "Signing in…" : "Not signed in";
  const id = esc(row.id);
  const actions = separate
    ? [
        row.status === "signed_in"
          ? `<button type="button" class="pill" data-act="identity-logout" data-id="${id}">Sign out</button>`
          : waiting || row.status === "not_installed"
            ? ""
            : `<button type="button" class="pill primary" data-act="identity-login" data-id="${id}">Sign in</button>`,
        `<button type="button" class="pill" data-act="identity-remove" data-id="${id}">Remove</button>`,
      ].join("")
    : "";
  return `<div class="row ident-row" data-id="${id}">
      <div><div class="lbl">${esc(identityWho(row))}</div><div class="sub">${scope}${bots}</div></div>
      <span class="hbadge ${tone}">${esc(status)}</span>
      ${actions ? `<span class="ident-actions" style="display:flex;gap:6px">${actions}</span>` : ""}
    </div>${identityLoginPanelHtml(row, { busy })}`;
}

/** Offer to drop logins that were added but never signed in. */
export function cleanupBannerHtml(count: number): string {
  if (!count) return "";
  const what = count === 1 ? "1 login was" : `${count} logins were`;
  return `<div class="card ident-cleanup"><div class="row"><div><div class="lbl">Unused logins</div><div class="sub">${what} added but never signed in, and no bot uses ${
    count === 1 ? "it" : "them"
  }. Remove ${count === 1 ? "it" : "them"}? Logins with an account or a bot are kept.</div></div>
    <span style="display:flex;gap:6px"><button type="button" class="pill primary" data-act="identity-cleanup">Remove</button><button type="button" class="pill" data-act="identity-cleanup-keep">Keep</button></span></div></div>`;
}
