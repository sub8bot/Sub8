# @sub8/orchestration

Shared contracts for Sub8 local desktop and Sub8 Cloud: `agent-data` paths, channel `group.json`, tool aliases, and code-agent session types.

Local Electron and the Cloud droplet must reuse this package instead of duplicating those shapes.

Cloud **vendors** the built `dist/` into `sub8-cloud/vendor/orchestration/` via `scripts/sync-orchestration.mjs`. A Cloudflare Worker cannot `import` this repo at deploy time.

Do not put Stripe, billing, provisioner, or secrets here. Those stay in the private cloud repo.
