# Cloud client (this repo)

Same license as the desktop ([BUSL-1.1](../../LICENSE)). This folder is a **client** plus a **dummy** for local tests.

**Login is on.** Sign in with X talks to `https://sub8.bot` (override with `SUB8_CLOUD_URL`). Always-on Cloud desks stay behind `SUB8_CLOUD=1`; otherwise the app shows **Cloud coming soon** and This Mac still works. Set `SUB8_ACCOUNT=0` to hide sign-in entirely. Dummy auth: `SUB8_CLOUD_URL=mock`.

The control plane (users, email, billing, Droplets) is a **separate repo**: `../sub8-cloud` (private). This app never contains those secrets.

The thing that sends magic-link email, stores users, bills Stripe, and creates Droplets is **not in this repository**. It lives in a private control-plane repo and speaks HTTP. Official DMGs set `SUB8_CLOUD_URL` at that API.

```
This Mac (BSL)          Cloud client (BSL)           Control plane (private)
Docker + harness   -->  dummy.mjs  (dev/test)
                   -->  http.mjs   (packaged)  -->  auth, billing, VMs
```

| Lives here (this repo) | Does not live here |
|---|---|
| Gate, `data/account.json` cache | User database |
| Dummy sign-in (`SUB8_CLOUD_URL=mock` or unpackaged) | Real email / GitHub OAuth |
| HTTP calls matching the contract below | Provisioner, Stripe, secrets |
| Local computers (`server/computers.mjs` + Docker) | Cloud VM lifecycle |

Do not add a second license in this tree. Do not gitignore a `closed/` folder in this repo — that still ships in clones and history. Private GitHub repo, separate.

## Auth contract

`authBackend().startMagic(email)` returns:

```js
{ mock, signedIn, email, session? }
```

- Dummy: `signedIn: true` and a `session` `{ email, userId, token, expiresAt }`
- HTTP: `signedIn: false`; the desktop later calls `completeSession` with the callback payload

Harness login (Grok OAuth, API keys) is not this module. That stays on the computer, local or cloud.
