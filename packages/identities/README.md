# @sub8/identities

Named provider sessions a bot can attach to. This package is the contract only:
normalize, migrate, resolve. No file I/O, no spawn, no tokens.

`server/` persists `data/identities.json` and runs login. The Cloud Worker
vendors `dist/` the same way it vendors `@sub8/orchestration`.
