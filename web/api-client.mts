// The one fetch wrapper the whole app talks through: JSON in, JSON out, and a
// non-2xx response becomes a thrown ApiError carrying the server's
// machine-readable fields instead of just a status line.

/** The three numbers spell out `| undefined` because apiErrorFrom always sets those keys. */
export interface ApiErrorFields {
  status?: number;
  code?: string;
  billingUrl?: string;
  sku?: string;
  used?: number | undefined;
  entitled?: number | undefined;
  unitAmountCents?: number | undefined;
}

/**
 * A failed api() call.
 *
 * `status` and `code` are always present — `code` is "" when the server sent
 * none. The billing fields are attached only when the server actually sent
 * them, so `"billingUrl" in err` still means "the server said so" rather than
 * "the field exists and is empty". Every field is `declare`d because a real
 * class field would be defined as undefined before the constructor body runs.
 */
export class ApiError extends Error {
  declare readonly code: string;
  declare readonly status: number;
  declare readonly billingUrl?: string;
  declare readonly sku?: string;
  declare readonly used?: number;
  declare readonly entitled?: number;
  declare readonly unitAmountCents?: number;

  constructor(
    message: string,
    { status = 0, code = "", billingUrl = "", sku = "", used, entitled, unitAmountCents }: ApiErrorFields = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (billingUrl) this.billingUrl = billingUrl;
    if (sku) this.sku = sku;
    if (used != null) this.used = used;
    if (entitled != null) this.entitled = entitled;
    if (unitAmountCents != null) this.unitAmountCents = unitAmountCents;
  }
}

interface ApiErrorBody extends ApiErrorFields {
  error?: string;
}

/**
 * Build the ApiError for a non-ok Response. Never throws: a body that is not
 * JSON (an HTML error page, an empty 502) just leaves the status line as the
 * message.
 */
export async function apiErrorFrom(res: Response): Promise<ApiError> {
  let msg = res.statusText;
  let fields: ApiErrorFields = {};
  try {
    const body: ApiErrorBody = await res.json();
    msg = body.error || msg;
    fields = {
      code: body.code || "",
      billingUrl: body.billingUrl || "",
      sku: body.sku || "",
      used: body.used,
      entitled: body.entitled,
      unitAmountCents: body.unitAmountCents,
    };
  } catch {}
  return new ApiError(msg, { ...fields, status: res.status });
}

export type FetchLike = (path: string, init: RequestInit) => Promise<Response>;

/** RequestInit, except `body` is the value to send — api() does the encoding. */
export interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

/** Bind the transport to a fetch. Tests pass a fake; the app passes the real one. */
export function createApi(fetchImpl: FetchLike) {
  return async function api(path: string, opts?: ApiOptions): Promise<unknown> {
    const { body, ...rest } = opts ?? {};
    const res = await fetchImpl(path, {
      headers: { "Content-Type": "application/json" },
      ...rest,
      // exactOptionalPropertyTypes: RequestInit.body has no undefined member, so
      // "no body" is an absent key — fetch reads that the same as undefined.
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw await apiErrorFrom(res);
    if (res.status === 204) return null;
    return res.json();
  };
}

export const api = createApi((...args) => fetch(...args));
