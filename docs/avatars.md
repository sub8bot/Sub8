# Grok Bot avatars

The app avatar is a live Three.js octopus (Smooth body) with emoji faces and looping motions. Preview every face and motion at `/tool.html`. Use this doc to drop the same thing into the main app.

## Files

| File | Role |
|---|---|
| `web/grok-bot.js` | 3D model: body, faces, motions |
| `web/avatar.js` | Shared renderer, color, mood inference, `syncAvatars` |
| `web/app.js` | Rail, header, settings, create flow |
| `web/tool.html` | Catalog for browsing faces and motions |
| `web/index.html` | Import map for `three` |

The server already serves `web/` and `/vendor/three`. No extra server work.

## Show an avatar

Give any element a `data-avatar` hook, then call `syncAvatars`.

```html
<div class="avatar-3d" data-avatar="bot-id" data-avatar-slot="rail" data-avatar-size="38"></div>
```

```js
import { defaultAvatar, inferMood, syncAvatars } from "./avatar.js";

syncAvatars([
  {
    id: bot.id,
    el,                       // the hook element
    slot: "rail",             // unique per instance of the same bot
    size: 38,                 // CSS pixels
    color: bot.color,         // body hex
    framing: "face",          // "face" = tight crop, "body" = full octopus
    mood: inferMood(bot),     // or defaultAvatar({ expression, animation })
  },
]);
```

Call `syncAvatars` again whenever bots, messages, or settings change. Views are created, updated, or disposed from that list.

The main app already does this in `refreshAvatars()` for:

- rail icons (`data-avatar-slot="rail"`, size 38)
- title (`title`, 28)
- picker (`pick`, 32)
- settings studio (`editor`, 148, `data-preview="1"`)
- create preview (`create`, 108, preview)

Preview mode skips mood inference and shows the saved face + motion.

## Saved shape

Each bot stores:

```js
{
  expression: "happy",   // face id
  animation: "idle",     // default motion
  body: "smooth"         // always Smooth
}
```

Use `defaultAvatar(partial)` so missing or unknown ids fall back safely.

Settings chips already PATCH this:

```js
bot.avatar = defaultAvatar({
  ...bot.avatar,
  expression: "joy",     // or animation: "bounce"
});
await api(`/api/bots/${bot.id}`, {
  method: "PATCH",
  body: { avatar: bot.avatar },
});
refreshAvatars();
```

Color is separate: `bot.color` (hex). Light bodies get **black** eyes and mouths. Dark bodies get **white**. Hearts stay red, stars yellow, tears blue, blush pink.

## Live mood

`inferMood(bot)` overrides the saved face/motion from conversation, unless `preview` is set:

| Situation | Face | Motion |
|---|---|---|
| VM error | `scared` | `shake` |
| User said something angry / sad / confused / loving / wow / happy / sleepy | matching face | matching motion |
| Bot busy, using the desktop | saved face | `look` |
| Bot busy, talking | saved face | `talk` |
| Just finished a reply | `happy` if saved was `neutral` | `nod` |
| Quiet ~6 minutes | saved face | `idle` |
| Quiet ~12 minutes | `sleepy` | `sleep` |
| `prefers-reduced-motion` | same faces | `none` |

To pin a face in the editor, pass `{ preview: true }`.

## Catalog

Open `http://127.0.0.1:8787/tool.html` while the server is running. Click a face or motion to preview. That page is a design tool only — it does not write to bots.

## Face ids

Pass these as `expression`:

`neutral` `slight` `happy` `blush` `grin` `beam` `laugh` `joy` `rofl` `party` `hug` `wink` `smirk` `love` `hearts` `kiss` `kissing` `star` `yum` `tongue` `winkTongue` `zany` `squintTongue` `think` `raised` `unamused` `expressionless` `deadpan` `nomouth` `eyeroll` `grimace` `shush` `oops` `cool` `sleepy` `sleep` `yawn` `relieved` `drool` `sad` `pensive` `disappointed` `cry` `weary` `pleading` `worried` `confused` `wow` `hushed` `flushed` `gasp` `dizzy` `woozy` `nauseous` `hot` `cold` `scared` `scream` `angry` `rage` `steam`

Lists for UI: `faceList()` → `{ id, label }`.

## Motion ids

Pass these as `animation`:

`none` `idle` `bounce` `hop` `float` `sway` `wiggle` `spin` `twirl` `nod` `shake` `look` `peek` `excited` `cheer` `dance` `talk` `sleep` `stretch` `shiver` `pulse`

Lists for UI: `animList()` → `{ id, label }` (`none` is labeled Still).

## Drop a bot in another page

Same import map as `index.html`, then:

```html
<div id="face"></div>
<script type="module">
  import { defaultAvatar, syncAvatars } from "./avatar.js";

  const el = document.querySelector("#face");
  syncAvatars([{
    id: "preview",
    el,
    slot: "hero",
    size: 160,
    color: "#ffe566",
    framing: "body",
    mood: defaultAvatar({ expression: "happy", animation: "idle" }),
  }]);
</script>
```

`framing: "body"` shows the full octopus. `framing: "face"` (app default) is a tight crop for small icons.

## Add a face or motion

1. Face: add an entry to `EXPRESSIONS` in `web/grok-bot.js` via `face('🙂 Label', { eye, mouth, blush, ... })`.
2. Motion: add an id to `ANIMATIONS` and a branch in `GrokBot._updateAnim` (and tentacle reaction in `_updateTentacles` if it should move the arms).
3. Check it in `/tool.html`, then it is available to `faceList()` / `animList()` and the settings chips automatically.
