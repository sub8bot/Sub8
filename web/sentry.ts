/**
 * Browser Sentry for the desktop renderer.
 *
 * The IIFE at /vendor/sentry.js is a one-file bundle of @sentry/browser
 * (no bundler for the rest of the app). Rebuild with:
 *   npx esbuild node_modules/@sentry/browser/build/npm/esm/prod/index.js \
 *     --bundle --format=iife --global-name=Sentry --platform=browser \
 *     --outfile=web/vendor/sentry.js --minify --legal-comments=none
 *
 * Chat bodies, vault paths, and auth query strings stay out of events.
 */

export const SENTRY_DSN =
  "https://f953dc5ff8f15b4b67ba3fd967ae779e@o4512007301169152.ingest.us.sentry.io/4512007318339584";

const SENSITIVE_API = /\/api\/(chat|messages|vault|account|grok|auth|login)/i;

type SentrySdk = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown) => void;
  setTag: (key: string, value: string) => void;
  browserTracingIntegration?: (opts?: Record<string, unknown>) => unknown;
};

type SentryBreadcrumb = {
  category?: string;
  type?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown> | undefined;
};

declare global {
  interface Window {
    Sentry?: SentrySdk;
  }
}

export function redactSentryUrl(url: string): string {
  const raw = String(url || "");
  const cut = raw.split("#")[0]?.split("?")[0] || raw;
  try {
    const u = new URL(cut, "http://127.0.0.1");
    return `${u.origin}${u.pathname}`;
  } catch {
    return cut;
  }
}

export function scrubSentryBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb | null {
  const data = breadcrumb.data;
  if (data && typeof data === "object") {
    const next: Record<string, unknown> = { ...data };
    delete next.body;
    delete next.request_body;
    delete next.response_body;
    if (typeof next.url === "string") {
      const url = next.url;
      next.url = redactSentryUrl(url);
      if (SENSITIVE_API.test(url)) delete next.query_string;
    }
    breadcrumb = { ...breadcrumb, data: next };
  }
  if (breadcrumb.category === "console" && (breadcrumb.level === "log" || breadcrumb.level === "debug")) {
    return null;
  }
  return breadcrumb;
}

function sentrySdk(): SentrySdk | undefined {
  return typeof window === "undefined" ? undefined : window.Sentry;
}

export function initSentry(): void {
  const Sentry = sentrySdk();
  if (!Sentry?.init) return;
  const desktop = Boolean(typeof window !== "undefined" && window.sub8Desktop);
  const integrations: unknown[] = [];
  if (typeof Sentry.browserTracingIntegration === "function") {
    integrations.push(
      Sentry.browserTracingIntegration({
        shouldCreateSpanForRequest: (url: string) => !/\/api\/bots\/[^/]+\/screen(?:\?|$)/.test(url),
      }),
    );
  }
  Sentry.init({
    dsn: SENTRY_DSN,
    release: "sub8@app",
    environment: desktop ? "desktop" : "browser",
    tracesSampleRate: desktop ? 0.2 : 1.0,
    tracePropagationTargets: ["127.0.0.1", "localhost", /^http:\/\/127\.0\.0\.1:\d+\//],
    integrations,
    ignoreErrors: ["ResizeObserver loop limit exceeded", "ResizeObserver loop completed with undelivered notifications"],
    beforeBreadcrumb(breadcrumb: SentryBreadcrumb) {
      return scrubSentryBreadcrumb(breadcrumb);
    },
    beforeSend(event: { request?: { data?: unknown; cookies?: unknown } }) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    },
  });
}

export function tagSentryVersion(version: string): void {
  const Sentry = sentrySdk();
  if (!Sentry?.setTag || !version) return;
  Sentry.setTag("app_version", version);
}

export function captureSentryException(err: unknown): void {
  sentrySdk()?.captureException?.(err);
}

initSentry();
