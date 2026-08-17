/** In-memory: human is driving this Bot's computer. */
const held = new Set();

export function setHumanControl(botId, on) {
  if (!botId) return false;
  if (on) held.add(botId);
  else held.delete(botId);
  return held.has(botId);
}

export function isHumanControl(botId) {
  return Boolean(botId && held.has(botId));
}
