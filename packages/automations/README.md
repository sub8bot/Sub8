# @sub8/automations

Standing routines: what the operator's text means as a cadence, when a routine
is next due, and what the desk's `automations/<slug>/automation.json` says.

Moved verbatim from `server/routines.mjs` (951 lines, zero internal imports).

## What is here

- **Instruction triage** — `looksLikeSchedule`, `isWeakRoutineInstruction`,
  `isRejectedRoutineInstruction`, `looksLikeTeammateTraffic`. A chat one-liner
  ("check again") must never become a standing job.
- **Cadence math** — `parseSchedule`, `parseCron`, `nextCalendarOccurrence`,
  `nextCronOccurrence`, `nextTriggerOccurrence`. Wall-clock, DST-correct: a 9 AM
  daily routine stays at 9 AM across a spring-forward, and a time that does not
  exist on a gap day advances rather than drifting.
- **Store shape** — `upsertRoutine`, `dueRoutines`, `packDue`, `hydrateRoutine`,
  and the legacy `intervalMs` → `schedule` migration.
- **Disk contract** — `automationJson` / `automationPath`, matching
  `@sub8/orchestration`'s `AutomationJson`.

## The one outward edge, and why it is injected

`server/routines.mjs` wrote the automation file through a deliberately lazy
`await import("./vm.mjs")` — the only thing in the file that reached outside it.
A package cannot import the container tunnel, so that seam is now explicit:

```js
import * as vm from "./vm.mjs";
import { setAutomationWriter } from "@sub8/automations";

setAutomationWriter(vm); // mkdirpInContainer + writeFileToContainer
```

The two host entry points (`server/index.mjs`, `server/mcp-sub8.mjs`) do this at
import time. Without a writer, `persistRoutineAutomation` is a no-op that returns
`null` — the in-memory `bot.routines[]` scheduler is unaffected, which is what
every test relies on.

## What is deliberately NOT here

The scheduler loop itself. `server/index.mjs` owns the timer, the wake, and the
turn it starts; this package only answers "is it due, and what does it say".
