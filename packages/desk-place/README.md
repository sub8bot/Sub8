# @sub8/desk-place

Pure host bin-packing for Sub8 desks: does this host have room for this
reservation, and which host is the tightest fit. No DigitalOcean, no Docker,
no billing — the contract the Worker's placer and the plan's tests share.

## What is here

- `usableHost(ramMb, diskGb, milliCpus)` — raw droplet capacity minus the host
  reserves (`HOST_RAM_RESERVE_MB` 2048, `HOST_DISK_RESERVE_GB` 30,
  `HOST_CPU_RESERVE_MILLI` 200). `HostSnapshot` capacities are the usable
  numbers; run raw specs through this first.
- `hostFits(host, want)` — RAM and disk are never oversubscribed; CPU may be
  promised `CPU_OVERSUBSCRIBE` (1.5×) over. A dedicated host, or a dedicated
  reservation, is the whole box or nothing: any existing tenant refuses it,
  and there is no CPU allowance.
- `pickHost(hosts, want)` — the fitting host with the least RAM left, or
  `null`. Region is not compared; filter hosts by region before calling.

## What is deliberately NOT here

- D1 `desk_hosts` rows, warm host pools, provisioning (`cloud/src/hosts.ts`)
- SKU → reservation mapping (`cloud/src/desk-limits.ts`; billing-aware)
- `docker run` argv (`@sub8/desk-runtime`)
