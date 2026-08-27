import * as store from "@sub8/store";
import * as channels from "@sub8/store/channels";
import * as vm from "./vm.mjs";

/**
 * Mirror a channel's group.json/profile.json into the desk of one of its
 * members, so `isChannel()` is true for the room on the desk side.
 *
 * Extracted from index.mts because the HTTP routes were the only callers: a
 * room created by the `create_channel`/`update_channel` TOOLS never got the
 * mirror, even though the tool description says "Writes group.json". Wakes
 * still worked (sendToAgent reads the host store), so the gap was invisible
 * until something on the desk asked whether the folder was a channel.
 */
interface DeskBotRow {
  id: string;
  vm?: { container?: string | null; deskUrl?: string | null; status?: string | null } | null;
}

function channelDeskContainer(
  bots: readonly DeskBotRow[],
  memberIds: readonly string[] | undefined,
): string | null {
  for (const id of memberIds || []) {
    const bot = bots.find((b) => b.id === id);
    if (!bot?.vm?.container || bot.vm.deskUrl || bot.vm.status === "missing") continue;
    return bot.vm.container;
  }
  return null;
}

export async function writeChannelToDesk(channel: channels.Channel | null | undefined): Promise<void> {
  if (!channel?.id) return;
  const bots = (await store.loadBots()) as DeskBotRow[];
  const container = channelDeskContainer(bots, channel.memberIds);
  if (!container) return;
  await channels.syncGroupJsonToDesk(channel, async (dest: string, text: string) => {
    const dir = dest.slice(0, dest.lastIndexOf("/"));
    await vm.mkdirpInContainer(container, dir);
    await vm.writeFileToContainer(container, dest, text);
  });
}

/** Fire-and-forget: a desk that is down must not fail the call that made the room. */
export function syncChannelDesk(channel: channels.Channel | null | undefined): void {
  writeChannelToDesk(channel).catch((err: unknown) =>
    console.error("sync channel desk", (err as Error)?.message || err),
  );
}
