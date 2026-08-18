import assert from "node:assert/strict";
import { loginNeedle, scoreVaultAccount } from "../server/agent.mjs";

assert.equal(loginNeedle("login to gmail"), "gmail");
assert.equal(loginNeedle("Sign in to mail.google.com"), "mail.google.com");
assert.equal(loginNeedle("hi"), "");

const gmail = { label: "Gmail", site: "mail.google.com", username: "AikaBotto" };
const x = { label: "X", site: "x.com", username: "dan" };
assert.ok(scoreVaultAccount(gmail, "gmail") > scoreVaultAccount(x, "gmail"));
assert.ok(scoreVaultAccount(x, "x.com") > 0);
assert.equal(scoreVaultAccount(x, "gmail"), 0);
console.log("ok login-intent");
