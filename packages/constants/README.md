# @sub8/constants

Pure constants and isolation guards. No I/O, no dependencies — safe for the
desktop server, the desk harness and the web app to share.

## What is here

- `AVATAR_COLORS` — moved from `web/palette.js`, which `server/store.mjs:2` and
  `server/cloud/draft.mjs:3` both import. That is the server reaching sideways
  into the web tree, and it is why `web/palette.js` needed its own `asarUnpack`
  entry. Adopting this removes the layering violation.
- `requireVm` / `isHostPath` / `assertVmShell` — the two-tunnel rule: computer-use
  outside the VM, shell only inside it, never the host Mac.

## What is deliberately NOT here

`server/paths.mjs` looks like it belongs, but it derives `appRoot` from **its own
file location** (`path.resolve(here, "..")`) and maps `.asar` → `.asar.unpacked`.
Moving it into a package silently changes what it resolves to. It needs a factory
that takes the app root as an argument before it can move; copying it as-is would
be a subtle, packaging-only breakage.

## One behaviour change vs server/isolation.mjs

The cookie/secret guard matched `\b(cat|sqlite|python|…)\b`. `\bsqlite\b` does
**not** match `sqlite3`, and `\bpython\b` does not match `python3` — the trailing
digit kills the word boundary. Those are the real binary names, so the original
guard is evadable. This version matches `sqlite\d*` / `python\d*`.

**`server/isolation.mjs` still has the gap.** It is fixed when that file adopts
this package; until then the two differ.
