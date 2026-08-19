export function frameKey(bot) {
  if (!bot?.id || !bot?.vm?.novncPort) return null;
  return `${bot.id}:${bot.vm.novncPort}`;
}

export function applyHealthPort(bot, health) {
  const port = health?.novncPort;
  if (!bot?.vm || !port || bot.vm.novncPort === port) return { bot, changed: false };
  return { bot: { ...bot, vm: { ...bot.vm, novncPort: port } }, changed: true };
}

export function healthIframeIsCurrent(iframe, bot) {
  const key = frameKey(bot);
  return Boolean(iframe && key && iframe.dataset?.key === key);
}
