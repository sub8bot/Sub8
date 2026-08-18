# VM Manager

Implemented in the app. This is the living spec.

## What happens today

Closing Sub8 does **not** stop the computers. Electron kills the Node server and the window. Docker is left alone.

Each Bot owns one webtop container named `localbot-<first 8 of bot id>` and a volume `localbot-config-<same>`. Files and logins live on that volume.

Deleting a Bot always runs `stopVm({ wipe: true })`: container gone, volume gone. There is no “keep the computer.”

`sweepOrphans` then deletes any `localbot-*` container or volume that is not on the remaining bot list. So a leftover computer cannot exist unless we change that.

Pause does not exist. Settings → Computer can Reload (start/attach) or Reset (destroy and make a new empty one).

## Goal (v1)

A Computers panel, same place as the vault: title-bar icon to the left of the lock.

From it you can:

- See every Sub8 computer (running, paused, stopped, unattached)
- See RAM / CPU for running ones (`docker stats`)
- Start, pause, resume, stop (container off, volume kept), or destroy (volume gone)
- See which Bot is attached
- Attach an unattached computer to a Bot that has none
- Detach a computer from a Bot without deleting the disk
- On Bot delete: choose **Keep computer** or **Delete computer**

Not in v1: two Bots driving one computer at once (different apps / browser profiles). The data model should not make that impossible later.

## Why the model has to change

Today the computer **is** the Bot id. Attach-to-another-Bot is impossible without renaming Docker objects mid-flight.

v1 introduces a **Computer** record with its own id. A Bot points at a computer. A computer may point at zero or one Bot.

```
Computer
  id            uuid
  name          "Pepe's desk" (editable)
  container     localbot-<id8>     // from computer id, not bot id
  volume        localbot-config-<id8>
  status        running | paused | exited | missing
  novncPort
  createdAt
  lastBotId     last attachment (for the row label)

Bot.vm
  computerId    uuid | null
  container, volume, novncPort, status   // cache of the attached computer
```

Existing bots migrate on first load: create a Computer from `bot.vm` / `containerName(bot.id)`, set `bot.vm.computerId`. Old container names stay. Do not recreate running boxes.

Unattached computers are listed. `sweepOrphans` must keep any computer in the registry, not only those owned by a live Bot.

## Quit and relaunch

Quit **pauses** every computer that is running. It does not stop or wipe them. Open windows and RAM stay; CPU drops. Disks stay.

Before the window dies, show a small sheet: “Pausing computers…” with a count (`2 of 5`). No extra choices on the way out — quitting should be one click. If a pause hangs more than a few seconds, skip that box and quit anyway. Never trap the user in the quit path.

Mark those rows `pausedByQuit: true`.

On next launch, **unpause only those**. A computer the user Stopped in the panel stays stopped. A computer that was already paused by hand stays paused.

Routines that were mid-flight will stall while paused and pick up after unpause if the harness is still in the same session. That is acceptable for v1. We do not auto-restart a turn.

Later, if people want “leave them running overnight,” add a single Settings toggle. Default stays pause-on-quit.

## Actions

| Action | Docker | Disk (volume) | Stream |
|---|---|---|---|
| Pause | `docker pause` | kept | frozen |
| Resume | `docker unpause` | kept | live |
| Stop | `docker stop` then `rm` container | kept | dead until Start |
| Start | `docker start` or `run` with same volume | kept | live |
| Destroy | `rm -f` + `volume rm` | gone | — |
| Detach | none | kept | Bot pane shows “no computer” |
| Attach | none if already running; else Start | kept | that Bot’s pane |

Pause vs Stop: Pause is instant and keeps RAM. Stop frees RAM and needs a longer boot.

A Bot with a live turn cannot be detached until Stop on that turn, or we abort the turn first.

Attaching computer C to Bot B:

- If B already has a computer, refuse unless they detach first. No silent swap.
- If C is attached to another Bot, detach that one first (with confirm).
- v1: one Bot per computer.

## Delete Bot

Replace the one-line confirm with a real choice. Default is keep.

**Delete “Pepe”?**

- **Keep the computer** (default) — Pepe leaves the rail. The Linux desk stays under Computers, unattached. Files, Chrome, and logins are still there. Attach it to another Bot later.
- **Delete the computer too** — The desk is destroyed. That volume is gone. Say this in the button subtitle so it is obvious.
- **Cancel**

No silent wipe.

## UI

Title bar, right cluster, left of the vault lock: a small computer icon. Badge = count of running computers (not paused/stopped).

Click opens a modal in the same family as Vault (left list, right detail).

**List row**

- Name
- State pill: Running / Paused / Stopped / Missing
- Attached Bot name or “Unattached”
- Live RAM if running (`123 MB`)

**Detail**

- Name (rename)
- State, RAM, CPU
- Attached Bot
- Port
- Container + volume (muted, copyable)
- Buttons: Pause/Resume, Stop, Start, Detach, Attach to…, Destroy
- Attach to… is a Bot picker (only bots with no computer)

No desktop preview in v1. Open the Bot if you want the stream.

## API (sketch)

```
GET    /api/computers
POST   /api/computers/:id/{start,pause,resume,stop,destroy}
POST   /api/computers/:id/attach   { botId }
POST   /api/computers/:id/detach
PATCH  /api/computers/:id          { name }
DELETE /api/bots/:id               { keepComputer?: true }
```

Stats: poll `docker stats --no-stream` every few seconds while the modal is open. Do not stream stats when the modal is closed.

## Later (explicitly out)

- Several Bots on one computer (separate browsers / apps)
- Creating a blank computer with no Bot
- Moving a volume to another machine
- Auto-pause on quit (unless we add the toggle)

Those need a session / display / Chrome-profile split we do not have yet. v1 only makes computers first-class and re-attachable.

## Key decisions

1. Computers are their own records. Bots reference them.
2. Quit pauses running computers (sheet, then exit). Next launch unpauses only those we paused. User-stopped boxes stay stopped.
3. Delete Bot defaults to keep the computer, with an explicit wipe option and copy that says what happens.
4. v1 is one Bot ↔ one computer. Many-to-one is a later spec.
5. Pause and Stop are both real, and they mean different things.
6. Orphan sweep keeps registered computers, even with no Bot.

## PR plan (after approval)

1. Computer registry + migrate existing bots. No UI yet.
2. Delete Bot: keep vs wipe. Sweep respects registry.
3. Computers modal + title-bar icon + stats + start/pause/stop/destroy.
4. Attach / detach.
