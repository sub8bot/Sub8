/**
 * Avatar colours. Lives here because `server/store.mjs` and
 * `server/cloud/draft.mjs` both import `../web/palette.js` — the server
 * reaching sideways into the web tree, which is why `web/palette.js` had to be
 * listed in asarUnpack on its own.
 */
export const AVATAR_COLORS = [
  "#c44dff",
  "#ffcc00",
  "#ff8a3d",
  "#ff4d6d",
  "#ff2d95",
  "#a855f7",
  "#6366f1",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#eab308",
  "#f8fafc",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];
