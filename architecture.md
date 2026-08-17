# Sub8 architecture

Sub8 (package `sub8bot`) is a local desktop app for **personal bots**. Each bot has:

- a chat thread
- a 3D octopus avatar
- an optional Linux desktop (Docker Webtop + noVNC)
- standing **routines** that wake the bot on a timer

The model (default: Grok via `https://api.x.ai/v1`) never sees the host Mac filesystem. Computer use and shell run only inside that bot’s VM.

This document is a map of how the pieces talk to each other.

---

## 1. High level — what exists

```mermaid
flowchart LR
  Human[Human]
  Desk[Sub8 desktop app<br/>Electron + web UI]
  API[Local Express server<br/>127.0.0.1:8787]
  Disk[(User data<br/>bots, chats, screens, traces)]
  VM[Per-bot Linux computer<br/>Docker Webtop + noVNC]
  XAI[xAI / OpenAI-compatible API<br/>Grok]

  Human --> Desk
  Desk --> API
  API --> Disk
  API --> VM
  API --> XAI
  Desk -.->|iframe stream| VM
```

One sentence: **the UI is a client; the Node server is the brain; Docker is the bot’s hands; Grok decides what to do.**

---

## 2. High level — runtime processes

```mermaid
flowchart TB
  subgraph host [Host machine]
    start[start.sh / electron]
    elec[Electron main<br/>electron/main.mjs]
    win[BrowserWindow<br/>loads http://127.0.0.1:PORT]
    node[Node Express<br/>server/index.mjs]
    colima[Docker / Colima]
  end

  subgraph container [One container per bot]
    xfce[XFCE desktop]
    novnc[noVNC :3000]
    display[X display :1]
  end

  start --> elec
  start --> node
  elec --> win
  win -->|REST + SSE| node
  node -->|docker run/exec| colima
  colima --> container
  win -->|iframe /bots/:id/stream| novnc
```

- **Dev:** `zsh start.sh` starts Colima if needed, starts the server if port 8787 is free, then opens the packaged Electron app.
- **Packaged:** Electron `main.mjs` starts `server/index.mjs` as a child unless 8787 is already healthy. Data lives under the app userData folder (`SUB8BOT_DATA`).
- **Port:** Prefer 8787; fall back to 8791–8793 if busy.

---

## 3. High level — request path

```mermaid
sequenceDiagram
  actor User
  participant UI as web/app.js
  participant API as server/index.mjs
  participant Store as server/store.mjs
  participant Agent as server/agent.mjs
  participant VM as server/vm.mjs
  participant Model as xAI Grok

  User->>UI: Type message
  UI->>API: POST /api/bots/:id/messages
  API->>Store: Append user message
  API-->>UI: SSE message + bot
  API->>Agent: enqueueTurn / runTurn
  Agent->>Store: Load bot + settings
  Agent->>Model: Chat completions + tools
  loop Until send_message or stop
    Model-->>Agent: tool_call
    alt computer
      Agent->>VM: screenshot / click / type
    else shell
      Agent->>VM: docker exec
    else upsert_routine
      Agent->>Store: Save routine
    end
    Agent->>Model: tool result
  end
  Agent->>Store: Persist assistant messages
  API-->>UI: SSE bot + messages
```

---

## 4. Repository layout

| Path | Role |
|---|---|
| `electron/main.mjs` | Desktop shell, spawn server, window, cache, data migration |
| `server/index.mjs` | HTTP API, SSE, turn queue, static `web/` |
| `server/agent.mjs` | Model client, system prompt, tool loop |
| `server/vm.mjs` | Docker lifecycle, screenshot, input, stream proxy |
| `server/store.mjs` | `bots.json`, conversations, settings, avatar defaults |
| `server/routines.mjs` | Schedule parse, upsert, due routines |
| `server/isolation.mjs` | Host-path block, VM-only shell |
| `server/control.mjs` | Human-is-driving flag (pauses agent input) |
| `server/trace.mjs` | JSONL traces under `data/traces/` |
| `server/paths.mjs` | `appRoot`, unpacked files, `dataDir` |
| `web/app.js` | Main UI: rail, chat, settings, computer pane |
| `web/avatar.js` | Shared Three.js renderer, mood, look sliders |
| `web/grok-bot.js` | Procedural octopus: body, face, motion, color flash |
| `web/tool.html` | Avatar catalog |
| `web/palette.js` | Shared color swatches |
| `prompts/` | System + computer-control text |
| `vm/` | Webtop setup, click-lab |
| `data/` | Runtime state (not the product source) |

---

## 5. Server modules

```mermaid
flowchart TB
  idx[index.mjs]
  store[store.mjs]
  agent[agent.mjs]
  vm[vm.mjs]
  routines[routines.mjs]
  iso[isolation.mjs]
  ctrl[control.mjs]
  trace[trace.mjs]
  paths[paths.mjs]

  idx --> store
  idx --> agent
  idx --> vm
  idx --> routines
  idx --> ctrl
  idx --> trace
  agent --> vm
  agent --> routines
  agent --> iso
  agent --> ctrl
  vm --> iso
  vm --> trace
  store --> paths
  vm --> paths
  agent --> paths
```

### `index.mjs`

Express app. Serves:

- `/` → `web/index.html`
- `/tool.html` → avatar catalog
- `/vendor/three` → Three.js
- `/api/*` JSON
- `/api/events` Server-Sent Events
- `/api/bots/:id/stream` proxied noVNC (when the VM is up)

Keeps an **in-memory turn queue** per bot (`enqueueTurn`) so two chats do not interleave tools. `busyIds` drives the rail “busy” state. Extra user messages during a turn become **nudges** (or a parallel orchestrator reply if the message looks like a question).

### `store.mjs`

Single-writer access to disk:

- `data/bots.json` — all bots
- `data/conversations/<id>.json` — message arrays
- `data/settings.json` — harness, theme, flags
- `data/screens/<id>.png` — last screenshot

Normalizes missing `avatar` to `{ expression, animation, body: "rounder" }`.

### `agent.mjs`

Builds the model request:

1. Load prompts (`grok-bot-system.txt`, `computer-control.txt`, optional harness extras)
2. Attach bot name, instructions, routines, last messages
3. Call OpenAI-compatible chat with tools: `send_message`, `computer`, `shell`, `upsert_routine`, `list_routines`, …
4. Execute tools against **that bot’s VM only**
5. Loop until the model calls `send_message` or the user hits stop

If `isHumanControl(botId)` the agent must not drive the desktop.

### `vm.mjs`

- Image: `linuxserver/webtop:ubuntu-xfce` (override `LOCALBOT_IMAGE`)
- Container name: `localbot-<botId-prefix>`
- Starts noVNC; assigns a host port from 13100 up
- `computer` actions become xdotool / scrot / clipboard inside the container
- Screenshots are 1024×768; click coordinates are pixels on that image

### Two tunnels (`isolation.mjs`)

```mermaid
flowchart LR
  Agent[agent.mjs]
  subgraph outside [Outside tunnel]
    CU[computer tool<br/>screenshot click type]
  end
  subgraph inside [Inside tunnel]
    SH[shell tool<br/>docker exec]
  end
  VM[Bot VM]
  Host[Host Mac files]

  Agent --> CU --> VM
  Agent --> SH --> VM
  CU -.->|blocked| Host
  SH -.->|blocked if /Users or host paths| Host
```

---

## 6. HTTP API

```mermaid
flowchart TB
  subgraph live [Live]
    ev[GET /api/events]
    health[GET /api/health]
    ready[GET /api/ready]
  end

  subgraph settings [Settings]
    gs[GET /api/settings]
    ps[PUT /api/settings]
    grok[POST /api/harness/grok-login]
    test[POST /api/harness/test]
    search[POST /api/search]
    dictate[POST /api/dictate]
  end

  subgraph bots [Bots]
    list[GET /api/bots]
    one[GET /api/bots/:id]
    create[POST /api/bots]
    patch[PATCH /api/bots/:id]
    del[DELETE /api/bots/:id]
    dup[POST /api/bots/:id/duplicate]
  end

  subgraph talk [Turns]
    msg[POST /api/bots/:id/messages]
    stop[POST /api/bots/:id/stop]
    teach[POST /api/bots/:id/teach]
  end

  subgraph desk [Computer]
    vm[POST /api/bots/:id/vm]
    ctrl[POST /api/bots/:id/control]
    screen[GET /api/bots/:id/screen]
    stream[GET /api/bots/:id/stream]
    shealth[GET /api/bots/:id/stream-health]
    trace[GET /api/bots/:id/trace]
  end

  subgraph jobs [Routines]
    rl[GET /api/bots/:id/routines]
    rc[POST /api/bots/:id/routines]
    rp[PATCH /api/bots/:id/routines/:rid]
    rd[DELETE /api/bots/:id/routines/:rid]
  end
```

**SSE events** (`/api/events`): `bot`, `message`, `settings`, plus busy/error updates. The UI holds one EventSource and re-renders from those events.

---

## 7. Chat turn in detail

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Queued: POST messages
  Queued --> Running: dequeue
  Running --> ToolCall: model returns tool_calls
  ToolCall --> Computer: computer
  ToolCall --> Shell: shell
  ToolCall --> Routine: upsert_routine
  ToolCall --> Chat: send_message
  Computer --> Running: tool result
  Shell --> Running: tool result
  Routine --> Running: tool result
  Chat --> Idle: persist + SSE
  Running --> Idle: stop / error
  Running --> Nudge: extra user line
  Nudge --> Running: pullNudges into next step
```

Nudge vs question:

- Short “keep going” text is a **nudge** into the same turn
- A real question can get a side **orchestrator** reply so the user is not ignored while the desktop is busy

`hidden` turns (routines) write fewer user-visible lines.

---

## 8. Routines

```mermaid
flowchart LR
  Chat[User chat] --> Parse[routines.parseSchedule]
  Parse -->|looks scheduled| Upsert[upsert_routine tool]
  Upsert --> Disk[(bot.routines in bots.json)]
  Tick[Interval timer in index.mjs] --> Due{due and enabled?}
  Due -->|yes| Hidden[runUserTurn hidden]
  Hidden --> Agent
  UI[Settings routine list] --> CRUD[REST routines]
  CRUD --> Disk
```

A routine is `{ id, name, instruction, intervalMs, groupKey, enabled, lastRunAt }`. Groups include `general`, `x-inbox`, `email`, `flights`, `calendar`, `files`.

---

## 9. Persistence model

```mermaid
erDiagram
  SETTINGS ||--o{ BOT : configures
  BOT ||--o{ MESSAGE : has
  BOT ||--o{ ROUTINE : has
  BOT ||--o| AVATAR : has
  BOT ||--o| VM : has

  SETTINGS {
    string harness_provider
    string harness_model
    string harness_baseUrl
    string apiKeyEnv
    string themePreference
  }

  BOT {
    uuid id
    string name
    string color
    string instructions
    bool pinned
    string section
  }

  AVATAR {
    string expression
    string animation
    string body
  }

  VM {
    string status
    string container
    int novncPort
  }

  MESSAGE {
    string id
    string role
    string content
    int ts
  }

  ROUTINE {
    uuid id
    string instruction
    int intervalMs
    bool enabled
  }
```

On disk:

```
data/
  bots.json
  settings.json
  conversations/<botId>.json
  screens/<botId>.png
  traces/<botId>.jsonl
```

Packaged app: same shape under `Application Support/Sub8/data` (legacy OctoBot / Sub8Bot folders are copied once).

---

## 10. Frontend — main app

```mermaid
flowchart TB
  html[index.html]
  app[app.js]
  api[api helper]
  sse[EventSource /api/events]
  av[refreshAvatars]
  paint[paintRail paintChat paintEditor]

  html --> app
  app --> api
  app --> sse
  sse --> paint
  api --> paint
  paint --> av
  av --> avatar[avatar.js syncAvatars]
  avatar --> grok[grok-bot.js GrokBot]
```

**`app.js` responsibilities**

- Global `state`: bots, selected id, settings, desk size, editor, teach mode
- `render()` / targeted `paint*` functions (avoid wiping focused inputs)
- Chat composer, image attach, dictate (`POST /api/dictate` → Swift on macOS)
- Rail: select, pin, unread, hide, sections
- Bot settings: name, color, **body / face / motion** chips, instructions
- Computer pane: iframe stream, Take control / Give back (`/control`)
- Teach: capture frames, `POST /teach`

**Avatar hook**

Any element:

```html
<div data-avatar="BOT_ID" data-avatar-slot="rail" data-avatar-size="56" data-avatar-framing="body"></div>
```

`refreshAvatars()` collects hooks, runs `inferMood` (or preview), passes `color` + `body`, then `syncAvatars`.

---

## 11. Avatar system

```mermaid
flowchart TB
  subgraph catalog [Catalog tool.html]
    tool[tool.js]
    ls[(localStorage octobot-catalog)]
    tool --> ls
  end

  subgraph shared [Shared]
    pal[palette.js colors]
    av[avatar.js]
    gb[grok-bot.js]
    look[LOOK_DEFAULTS + sliders]
  end

  subgraph appui [App app.js]
    chips[Body Face Motion chips]
    rail[Rail icons]
    infer[inferMood from last chat]
  end

  tool --> av
  chips --> av
  rail --> av
  infer --> av
  ls --> look
  look --> av
  pal --> av
  av --> gb
  gb --> three[Three.js WebGL]
```

### `grok-bot.js`

Procedural mesh, not a loaded GLB.

- **Body** — sphere deformed by `form` (`mantle` / `rounder` / …) then tentacles attached on the surface
- **Face** — stadium / round / heart / star / line eyes + graphic mouths
- **Motion** — `playAnimation` + `_updateAnim` + tentacle wiggle
- **Flash** — for Cold / Hot / Angry / Rage / Steam / Sick / Love, lerp body color every ~5s

Default body id: **`rounder`**.

### `avatar.js`

- One offscreen `WebGLRenderer`, many views (one per hook)
- Look sliders: gloss, shine size/blur/position, lights, color punch
- Look is stored in `localStorage` key `octobot-catalog` and **also applied in the main app**
- `inferMood`: last user text + VM error + busy/look/talk + idle sleep
- Color expressions pulse via `GrokBot._flashBody` on every `update()` tick

### Catalog (`tool.html`)

Design surface: bodies, faces, motions, colors, look sliders. Does not write bots unless you copy ids into Settings.

---

## 12. Computer pane

```mermaid
sequenceDiagram
  participant UI
  participant API
  participant Docker
  participant Webtop

  UI->>API: POST /vm action start
  API->>Docker: run webtop if needed
  Docker-->>API: novncPort
  API-->>UI: bot.vm.status running
  UI->>API: GET /bots/:id/stream
  API->>Webtop: proxy noVNC
  Webtop-->>UI: desktop frames

  UI->>API: POST /control on
  Note over API: human control set
  Note over Agent: computer tool refused

  UI->>API: POST /control off
  Note over Agent: computer tool allowed again
```

Human control is in-memory only (`control.mjs`). Restarting the server clears it.

---

## 13. Frontend ↔ server events

```mermaid
flowchart LR
  UI[app.js]
  SSE[GET /api/events]
  REST[REST writes]

  UI --> REST
  REST --> Q[Turn queue]
  Q --> Agent
  Agent --> Store
  Store --> Broadcast[broadcast event]
  SSE --> UI
  Broadcast --> SSE
```

The UI does not poll bots. After the first `GET /api/bots`, it stays live through SSE.

---

## 14. Security boundaries

```mermaid
flowchart TB
  subgraph allowed [Allowed]
    Model[Grok]
    Server[Local Node]
    VM[Bot container]
  end

  subgraph denied [Not allowed]
    Mac[Host home / Library / Applications]
    OtherVM[Another bot's container]
  end

  Model --> Server
  Server --> VM
  Server -.->|blocked| Mac
  VM -.->|no mount of host home| Mac
  Server -.->|wrong container name| OtherVM
```

- Shell commands mentioning `/Users` are rejected
- Computer actions require `vm.container` starting with `localbot-`
- API is bound to localhost

---

## 15. How to extend

| Want | Where |
|---|---|
| New face | `EXPRESSIONS` in `web/grok-bot.js` |
| New motion | `ANIMATIONS` + `_updateAnim` |
| New body | `BODIES` + `_shapeVertex` / tentacle curve |
| New color | `web/palette.js` |
| New tool | `TOOLS` + handler in `agent.mjs` |
| New API | route in `server/index.mjs` + `app.js` |
| Prompt change | `prompts/*.txt` |
| Default look | `LOOK_DEFAULTS` in `avatar.js` |

---

## 16. Mental model

```mermaid
mindmap
  root((Sub8))
    You
      Chat
      Settings
      Catalog
    Local server
      Bots file
      Turn queue
      SSE
    Each bot
      Avatar
      Thread
      Routines
      Linux desktop
    Grok
      send_message
      computer
      shell
      upsert_routine
```

If you only remember one picture: **a thin Electron window over a local API that rents each bot its own Linux box and asks Grok what to do there.**
