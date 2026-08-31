/**
 * The slice of Express 5 this server uses, hand-written.
 *
 * express@5.2.1 ships no types and there is no `@types/express` in the tree, so
 * without this file `import express from "express"` is an implicit `any` and
 * every one of the 104 route handlers in index.mts takes two implicitly-`any`
 * parameters. Declaring the surface here instead of installing a dependency
 * keeps package.json alone, and — because `app.get(path, handler)` is typed —
 * gives every handler's `req`/`res` a contextual type, so not one route in
 * index.mts needs a parameter annotation.
 *
 * This is a script, not a module (no top-level import/export), which is what
 * lets `declare module "express"` be an ambient declaration rather than a
 * module augmentation. Node's http types are reached through `import("…")`
 * types inside the block for the same reason.
 *
 * Only what index.mts calls is declared. `Request` and `Response` extend the
 * Node objects express actually decorates, so `req.on`, `req.setTimeout`,
 * `res.write`, `res.setHeader`, `res.flushHeaders` and `res.end` are the real
 * ones and not restatements.
 */
declare module "express" {
  /**
   * The desk-tool arguments `POST /api/internal/desk-tool` forwards. Same rule
   * as mcp-sub8's `ToolArgs`: this is JSON off the wire, so a field is a claim
   * and not a fact — anything the route coerces itself stays `unknown`, and
   * only what is handed straight to a typed callee is spelled tighter.
   */
  export interface DeskToolArgs {
    bot_id?: string | undefined;
    content?: string | undefined;
    id?: string | undefined;
    job?: string | undefined;
    message?: string | undefined;
    name?: string | undefined;
    prompt?: unknown;
    role?: string | undefined;
    type?: unknown;
    harness?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
  }

  /** One entry of `POST /api/teams`'s `members`. */
  export interface TeamMemberSeed {
    avatar?: RequestAvatar | undefined;
    harness?: RequestHarness | undefined;
    name?: string | undefined;
    role?: string | undefined;
  }

  /**
   * A bot's look as a body carries it. No `| undefined` on the fields: this is
   * assigned into `@sub8/store`'s `Partial<BotAvatar>`, which under
   * exactOptionalPropertyTypes is `?: string` and not `?: string | undefined`.
   */
  export interface RequestAvatar {
    animation?: string;
    body?: string;
    expression?: string;
  }

  /** `harness` as a settings write or a team seed carries it. */
  export interface RequestHarness {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    model?: string | undefined;
    provider?: string | undefined;
    [key: string]: unknown;
  }

  /**
   * Every field this server reads off a parsed JSON body, in one place, because
   * one `Request` is the contextual type of all 104 handlers.
   *
   * Each field is spelled the way its readers use it: `unknown` where the route
   * coerces the value itself (`Boolean(…)`, `!== false`, `String(…)`), and the
   * concrete type where the value is handed straight to a typed callee. None of
   * it is proven — the client picks what it sends — which is why almost every
   * read below is guarded by a truthiness test or a `String()`.
   *
   * `body` is not optional here even though express leaves it `undefined` for a
   * request it did not parse (no JSON content-type). Spelling it optional would
   * only move that fact into 106 `?.` reads that already exist.
   */
  export interface RequestBody {
    accountIds?: string[] | undefined;
    action?: string | undefined;
    add?: unknown[] | undefined;
    all?: unknown;
    args?: DeskToolArgs | undefined;
    avatar?: RequestAvatar | undefined;
    botId?: string | undefined;
    botIds?: unknown[] | undefined;
    choiceId?: string | undefined;
    computerId?: string | undefined;
    content?: string | undefined;
    custom?: string | undefined;
    data?: Record<string, unknown> | undefined;
    description?: string | undefined;
    dismiss?: unknown;
    display?: unknown;
    email?: unknown;
    enabled?: boolean | undefined;
    event?: string | undefined;
    force_new?: unknown;
    frames?: unknown[] | undefined;
    fromId?: string | undefined;
    group_key?: string | undefined;
    groupKey?: string | undefined;
    harness?: RequestHarness | undefined;
    id?: string | undefined;
    images?: unknown[] | undefined;
    instruction?: string | undefined;
    instructions?: string | undefined;
    interval_minutes?: number | undefined;
    intervalMinutes?: number | undefined;
    intervalMs?: number | undefined;
    items?: unknown;
    job?: string | undefined;
    keepComputer?: unknown;
    memberIds?: unknown;
    members?: TeamMemberSeed[] | undefined;
    messageId?: string | undefined;
    model?: string | undefined;
    name?: string | undefined;
    never?: unknown;
    on?: unknown;
    pinned?: unknown;
    provider?: string | undefined;
    query?: string | undefined;
    remove?: unknown[] | undefined;
    schedule?: unknown;
    section?: unknown;
    size?: string | undefined;
    sku?: string | undefined;
    solo?: unknown;
    steps?: import("./teams.mjs").JobStepSeed[] | undefined;
    stopId?: string | undefined;
    title?: string | undefined;
    toId?: string | undefined;
    toIds?: unknown[] | undefined;
    triggers?: unknown[] | undefined;
    turnId?: string | undefined;
    view?: unknown;
    wipe?: unknown;
    [key: string]: unknown;
  }

  /**
   * The `:name` segments the routes in index.mts declare. Express hands back a
   * dictionary; naming the keys instead of an index signature is what
   * keeps `req.params.id` a `string` under noUncheckedIndexedAccess, which is
   * what the route that declared `:id` already knows it is.
   */
  export interface RouteParams {
    action: string;
    botId: string;
    id: string;
    imageId: string;
    mid: string;
    rid: string;
  }

  /**
   * `?a=b`, as this server reads it. qs can also produce arrays and nested
   * objects; every reader here either `String()`s the value or forwards it to a
   * callee that takes `string | undefined`, so the narrow spelling is the one
   * that describes this file. Absent keys are `undefined` either way.
   */
  export type RequestQuery = Record<string, string | undefined>;

  /** The two Node objects express decorates, named so `extends` can reach them. */
  type NodeRequest = import("node:http").IncomingMessage;
  type NodeResponse = import("node:http").ServerResponse;

  export interface Request extends NodeRequest {
    body: RequestBody;
    /** One request header, case-insensitive. */
    get(name: string): string | undefined;
    params: RouteParams;
    query: RequestQuery;
  }

  export interface Response extends NodeResponse {
    /** Serializes and sends, setting `Content-Type: application/json`. */
    json(body: unknown): this;
    send(body: string | Buffer): this;
    /** Streams a file from disk. Ends the response itself. */
    sendFile(filePath: string): void;
    status(code: number): this;
    /** Sets `Content-Type` from an extension or a full type. */
    type(contentType: string): this;
  }

  /**
   * A route handler. Declared `void` on purpose: TypeScript lets a function
   * that returns something stand where a `void` one is wanted, which is what
   * makes the `return res.status(404).json(…)` early-outs and the `async`
   * handlers below type-check without a cast.
   */
  export type Handler = (req: Request, res: Response) => void;
  export type Middleware = (req: Request, res: Response, next: (err?: unknown) => void) => void;
  /**
   * Express tells an error handler apart from a plain one by ARITY — four
   * declared parameters, not three. Typed separately so the app.use overload
   * below can accept it; the shim had no way to express one before, which is
   * part of why the server ran without an error handler at all.
   */
  export type ErrorMiddleware = (
    err: Error,
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ) => void;

  export interface JsonOptions {
    limit?: string;
  }

  export interface StaticOptions {
    etag?: boolean;
    lastModified?: boolean;
    setHeaders?: (res: Response, filePath: string) => void;
  }

  export interface App {
    delete(path: string, handler: Handler): this;
    get(path: string, handler: Handler): this;
    listen(port: number, host: string, listening?: () => void): import("node:http").Server;
    patch(path: string, handler: Handler): this;
    post(path: string, handler: Handler): this;
    put(path: string, handler: Handler): this;
    use(handler: Middleware): this;
    use(handler: ErrorMiddleware): this;
    use(path: string, handler: Middleware): this;
  }

  /** The default export: callable, and the namespace the middleware hangs off. */
  export interface Express {
    (): App;
    json(options?: JsonOptions): Middleware;
    static(root: string, options?: StaticOptions): Middleware;
  }

  const express: Express;
  export default express;
}
