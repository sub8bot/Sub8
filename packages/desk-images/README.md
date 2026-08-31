# @sub8/desk-images

Pure argv builders for snapshotting and restoring a desk's **named volume**
(the customer disk) via an injected docker runner. The volume is the disk;
the image tag is not.

## What is here

- `DockerRun` — `(argv: string[]) => Promise<{ ok; out; err }>` injected by the
  caller. This package never spawns docker.
- `snapshotArgs(volume, archiveAbs)` — `docker run --rm` + alpine `tar -czf`
  of `VOLUME:/from:ro` into `HOSTDIR:/to/BASENAME`.
- `restoreArgs(volume, archiveAbs)` — inverse: volume at `/to` (writable),
  archive dir at `/from`, `tar -xzf`.
- `listVolumeArgs()` — `["volume", "ls"]`.

Archive basenames that are empty or contain `..` throw
`Error("desk-images: bad archive path")`.

## What is deliberately NOT here

- A real docker spawn / daemon client inside this package (caller injects
  `DockerRun`).
- DigitalOcean, Stripe, or any provisioner / billing code.
- `docker commit`. Commit is not a backup; argv builders never emit `"commit"`.
