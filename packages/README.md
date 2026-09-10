# `packages/`

Sub8 is ~46k lines of `.mjs` plus a growing set of strict TypeScript packages.
New shared code lands here, not in `server/`. Each package is small, strict,
and independently testable.

`packages/orchestration` is the reference implementation — copy its shape.

## Shape

```
packages/<name>/
  package.json      # @sub8/<name>, private, type: module
  tsconfig.json     # extends ../../tsconfig.base.json
  src/*.ts          # the only thing tsc compiles
  test/*.test.mjs   # node --test, imports the built dist/ (or src for noEmit pkgs)
  fixtures/         # optional, real data the tests assert against
  README.md         # what belongs in here and what does not
  dist/             # emitted, gitignored — libraries only
```

## Rules

**1. Extend the shared base.** `tsconfig.base.json` at the repo root owns
`target`/`module`/`strict`. A package tsconfig should only add `rootDir`,
`outDir`/`noEmit`, `composite`, and `include`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "../../node_modules/.cache/sub8-tsbuildinfo/<name>.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

The `tsBuildInfoFile` redirect keeps `dist/` clean — Sub8 Cloud vendors
`dist/` verbatim, and `node_modules/` is already gitignored.

**2. Strict, with no escape hatches.** The base turns on `strict`,
`noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Do not add
`// @ts-nocheck`, `// @ts-ignore`, or `any` to get a package green. If the
types are fighting you, the contract is wrong — fix the contract.

**3. Libraries emit `dist/`; app code sets `noEmit`.** A package that other
code imports (`orchestration`) keeps `declaration: true` + `outDir: "dist"`,
so `.d.ts` ships and the Worker can vendor plain `.js`. A package that is only
ever run or bundled sets `"noEmit": true` and is typechecked, not built.
`noEmit` is compatible with `composite` on TypeScript 5.9 — keep both.

**4. Tests are `node --test`.** Plain `.test.mjs` files under `test/`, no test
framework, no transpile step. Name them `*.test.mjs` so the root
`npm run test:packages` glob (`packages/*/test/**/*.test.mjs`) finds them.
Library tests import `../dist/index.js` — that is the artifact consumers get,
so that is the artifact the tests should exercise.

**5. Zero runtime dependencies where possible.** `dependencies` should be
empty; `devDependencies` should be `typescript` and `@types/node` and nothing
else. These packages run in Electron, in Node, and inside a Cloudflare Worker.
Anything with a native binding or a Node-only import in its hot path does not
belong here. `@types/node` must be a real devDependency of the package: the
base config sets `"types": ["node"]`, which resolves per-package.

**6. No secrets, no billing, no provisioner.** Those stay in the private cloud
repo. `packages/` is the contract layer both sides agree on.

## Adding a package

1. `mkdir -p packages/<name>/{src,test}` and copy `package.json` +
   `tsconfig.json` from `packages/orchestration`, adjusting the name.
2. `cd packages/<name> && npm install` (typescript + @types/node).
3. Add one line to the root `tsconfig.json` references array:
   `{ "path": "./packages/<name>" }`. That is what puts it in
   `npm run typecheck`.
4. If `server/` or `electron/` import `@sub8/<name>`, add
   `"@sub8/<name>": "file:packages/<name>"` to the root `package.json`
   `dependencies`. electron-builder only copies that list into
   `app.asar/node_modules`; a missing entry whitescreens the shipped app
   (`ERR_MODULE_NOT_FOUND`). npm workspaces still hoist it locally, so
   `npm start` will not catch this.
5. `npm run check` from the repo root.

## Root scripts

| script | what it does | gates? |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b` over every referenced package; libraries emit `dist/` as a side effect | yes |
| `npm run test:packages` | `node --test` over `packages/*/test/**/*.test.mjs` | yes |
| `npm run check` | `typecheck` → `test:packages` → `npm test` (the legacy `.mjs` suite) | yes |
| `npm run typecheck:js` | `checkJs` over the legacy `.mjs`/`.js` tree via `tsconfig.jscheck.json` | **no** |

`typecheck:js` is a measuring stick, not a gate. It applies the same strict bar
to untyped JavaScript and reports how far away it is. The number goes down when
code moves into `packages/` — never by silencing an error.
