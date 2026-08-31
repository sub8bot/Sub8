# Disk snapshot UX

**Approved:** 2026-08-31 (operator: “build it”, entry A).

**Goal:** Snapshot/restore is findable from a bot, shows honest progress instead of “Working…”, and stays local-only.

## Entry

- Right-click a **rail bot** or a **chrome tab**: **Snapshots…**
- Local only. Hidden in live Cloud menus.
- Opens Computers, selects that bot’s `vm.computerId`, scrolls `#desk-snapshots` into view.
- No `computerId` → alert “This bot has no computer.”

## Panel

Computers detail, below Start/Stop/Destroy:

- Heading **Disk snapshots**
- Subtitle: “Saves this Linux desk’s files and Chrome profile. Chat stays in Sub8.”
- Button **Snapshot disk**
- Empty: “No snapshots yet.”
- Rows: date · size · Restore · Delete
- Restore confirm (unchanged). Delete confirm: “Delete this snapshot? The live desk is unchanged.”

## Progress

One POST/DELETE as today. While it runs, UI polls `GET /api/computers/:id/images/progress`.

Job: `{ computerId, action, phase, bytes, totalBytes }`.

Phases: snapshot `pausing` → `copying` (stat the tarball; `totalBytes` = latest snapshot size if any) → `resuming`. Restore `stopping` → `restoring` → `starting`. Delete `deleting`.

No job → `{ progress: null }`. Unknown computer → 404. Do not fake 0–100 when `totalBytes` is null; show bytes + indeterminate bar.

## Move to Cloud (feature flag)

`canMoveToCloud(ctx)` = `cloudProductOn` and not already `isCloudPlace`.

- Packaged Electron sets `SUB8_CLOUD=0` unless the env overrides it (`electron/main.mts`).
- Unpackaged local dev leaves `SUB8_CLOUD` empty → product on.
- UI: **Move to Cloud…** on rail/tab menus; **Move to Cloud** on the Disk snapshots row. Confirm, snapshot if there is a desk, `switchPlace("cloud")`, open create-computer when live.
- Does not copy the tarball onto a droplet (Gate 2).

## Out of scope

Rail restore onto a paying droplet. Notes editor. Vault. Retag `sub8-desk:trixie`. SSE/tar checkpoints.
