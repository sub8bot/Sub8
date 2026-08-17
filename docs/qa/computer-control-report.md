# Computer control QA

**Date:** 2026-08-17  
**Bot:** FieldTester (`555baff5-6fce-4533-85d4-8057e26d5e9f`)  
**Computer:** `localbot-555baff5` · display `:1` · 1024×768  
**Stack:** `octo-click` (move → confirm pointer → activate window → click)  
**Routine on this Bot:** none. Control rules live in `prompts/computer-control.txt` (loaded for every Bot).

## Verdict

The **pointer path is sound**. 60/60 aimed desktop pixels landed at Δ 0,0 on this Bot’s computer: empty XFCE desktop, Google Chrome (weather + flights + forms), and xfce4-terminal.

What still fails in production Bots (Aika) is **which pixel the model chooses**, not whether the click arrives. That belongs in the **core prompt**, not in each routine.

## Architecture change

| Before | After |
|---|---|
| Click / finish / verify text copied into Aika’s x-inbox routine | One file: `prompts/computer-control.txt` |
| SpaceXAI and Grok Build each restated X-specific click folklore | Same section injected into the system prompt **and** `/config/AGENTS.md` |
| “Confirm your post” as an X-only ritual | **Do → verify → log** for any primary button (Send, Save, Search, OK, Post, Reply) |

A new Bot with an empty routine still gets how to aim, finish, and verify.

## Method

1. Create FieldTester via `POST /api/bots` (no standing routine).  
2. Wait until `vm.status=running`.  
3. Install `octo-click` if missing.  
4. For each test: `octo-click X Y`, then `xdotool getmouselocation`. Pass if |Δx|≤2 and |Δy|≤2.  
5. Open real pages (`chrome-desktop URL`). Screenshot. Visually check that the page is the intended one and that the cursor sits on it.  
6. Form: local `demo-form.html` after `httpbin.org` returned 503.

## Results

### Pointer accuracy — 60 / 60 PASS

| Block | IDs | Surface | Result |
|---|---|---|---|
| A | T01–T15 | XFCE desktop (off icon column) | 15/15 |
| C | T16–T30 | Chrome content / chrome | 15/15 |
| D | T31–T40 | Terminal interior (window 202,208 718×382) | 10/10 |
| E | T41–T45 | wttr.in SFO weather | 5/5 |
| F | T46–T50 | Google Flights | 5/5 |
| G | T51–T55 | Form page pointer | 5/5 |
| H | T56–T60 | Extra desktop corners | 5/5 |

Every recorded pointer was **exact** (`landed = aim`).

### Visual inspection

**Desktop** (`docs/qa/shots/desktop.png`)  
Clean webtop, icons on the left, pointer on the wallpaper. Clicks in A/H were not on the panel.

**Weather** (`docs/qa/shots/weather.png`)  
`wttr.in/SFO` loaded. SFO forecast (Sun 16–Tue 18 Aug) is readable. Cursor sits in the Sunday evening cell after T45.

**Flights** (`docs/qa/shots/flights.png`)  
`google.com/travel/flights` loaded. Round trip / 1 / Economy, Bangkok, Where to?, Explore. Pointer on the “Flights” heading after T50.

**httpbin form** (`docs/qa/shots/form-before.png`)  
`https://httpbin.org/forms/post` → **503**. External dependency. Pointer tests still passed on that 503 page (white canvas). Not counted as a form-fill success.

**Local demo form** (`docs/qa/shots/demo-form-open.png`, `demo-form-after.png`)  
Form rendered. First fill: Notes received `QA run 50+`, Submit fired (`OK {"notes":"QA run 50+"}`). Name/email/city empty — those clicks were on the page but **not the field centers** (labels / padding). That is the same class of miss as Aika on Post: the mouse is exact; the chosen pixel is wrong.

### What this is not

This suite proves the **host → VM → xdotool** path. It does not prove the **model** will pick Post instead of Drafts. That is why finish/verify/log is in `computer-control.txt` for every Bot, not only in Aika’s routine.

## Failure modes (keep these out of routines)

| Symptom | Cause | Core rule |
|---|---|---|
| Click “misses” a button | Model aimed at the gap / text / sidebar | Click the visual center of a control you can see |
| Typed but nothing sent | Next click was the field, not Submit | After type, click the primary button |
| Duplicate / “already said that” | Action already landed | Close, log, do something new |
| Page `clientY` vs screenshot | ~110–120px browser chrome | Use screenshot pixels only |
| Infobar ate the click | Overlay, not offset | Dismiss chrome, retry same control |
| Window not up yet | Clicked too early | Wait, screenshot, then click |

## Files

- Core spec: `prompts/computer-control.txt`  
- Injected by `loadSystemPrompt` and `installAgentsMd`  
- Suite: `docs/qa/run-field-suite.sh`  
- Shots: `docs/qa/shots/`

## Follow-up (optional)

- Serve a local form fixture in every VM for regression (httpbin is flaky).  
- After `computer type`, the tool caption already tells the model to click the primary button next.  
- Do not bake X compose coordinates into new routines.
