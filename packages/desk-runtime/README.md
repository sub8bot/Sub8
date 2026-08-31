# @sub8/desk-runtime

Pure docker `run` argv and cgroup limits for a Sub8 desk. No Docker I/O, no
provisioner — safe for the desktop server and Sub8 Cloud to share as a contract.

## What is here

- `DeskLimits` / `limitsFromRamMb` — map billed RAM to memory, swap, shm, CPU,
  and pid cgroup caps. Unknown sizes round down to the next known rung; they
  never throw.

## What is deliberately NOT here

- Docker spawn / `docker run` I/O
- DigitalOcean droplet provisioning
- Stripe / billing
- Volume tar / desk image packaging

Those stay in the private cloud repo (rule 6). This package only shapes the
argv and limits both sides agree on.
