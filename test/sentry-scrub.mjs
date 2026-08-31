import assert from "node:assert/strict";
import { redactSentryUrl, scrubSentryBreadcrumb } from "../web/sentry.js";

assert.equal(redactSentryUrl("http://127.0.0.1:8787/api/chat?q=secret-name"), "http://127.0.0.1:8787/api/chat");
assert.equal(redactSentryUrl("/api/vault/foo?token=abc"), "http://127.0.0.1/api/vault/foo");

const fetchCrumb = scrubSentryBreadcrumb({
  type: "http",
  category: "fetch",
  data: {
    url: "http://127.0.0.1:8787/api/chat?text=hello",
    method: "POST",
    body: "keep me out",
    status_code: 200,
  },
});
assert.equal(fetchCrumb?.data?.url, "http://127.0.0.1:8787/api/chat");
assert.equal(fetchCrumb?.data?.method, "POST");
assert.equal("body" in (fetchCrumb?.data || {}), false);

const logCrumb = scrubSentryBreadcrumb({ category: "console", level: "log", message: "typed a prompt" });
assert.equal(logCrumb, null);

const errCrumb = scrubSentryBreadcrumb({ category: "console", level: "error", message: "attachLiveFrame" });
assert.equal(errCrumb?.message, "attachLiveFrame");

console.log("ok");
