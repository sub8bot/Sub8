/**
 * Team membership as the rail and the tab strip read it.
 *
 * Membership lives in two places: the team row (`chiefId`, `memberIds`) and
 * each bot (`teamId`, `teamRole`). They can disagree. A lead whose own row lost
 * its team fields still sat in the team's `memberIds`, so the tab strip (which
 * reads `memberIds`) showed "Team | Personal | Poster" while the rail (which
 * read `teamId`) showed both bots loose under Unassigned, the Team tab could
 * not find a lead by role ("the lead"), and selecting the lead dropped out of
 * the tabbed view.
 *
 * `reconcileTeamFields` fills the gaps on the client's copies from the team
 * rows, so every reader agrees. It only fills: a bot that already names a team
 * that exists keeps it, and a role already set is kept.
 */

/** The slice of a bot these helpers read and fill. */
export interface TeamFieldsBot {
  id: string;
  teamId?: string | undefined;
  teamRole?: string | undefined;
}

/** The slice of a team row these helpers read. */
export interface TeamRow {
  id: string;
  chiefId?: string | null | undefined;
  memberIds?: readonly string[] | undefined;
}

/** The team a bot belongs to: its own `teamId` when that team exists, else the team that lists it. */
export function teamIdFor(bot: TeamFieldsBot, teams: readonly TeamRow[]): string {
  const own = bot.teamId || "";
  if (own && teams.some((t) => t.id === own)) return own;
  const listed = teams.find((t) => t.chiefId === bot.id) || teams.find((t) => (t.memberIds || []).includes(bot.id));
  return listed?.id || own;
}

/** A bot's role on a team: its own `teamRole`, else "chief" for the team's `chiefId`, else "worker". */
export function teamRoleFor(bot: TeamFieldsBot, team: TeamRow | null | undefined): string {
  if (bot.teamRole === "chief" || bot.teamRole === "worker") return bot.teamRole;
  if (!team) return bot.teamRole || "";
  return team.chiefId === bot.id ? "chief" : "worker";
}

/**
 * Fill missing `teamId` / `teamRole` on each bot from the team rows, in place.
 * Returns how many bots changed. Idempotent.
 */
export function reconcileTeamFields(bots: readonly TeamFieldsBot[], teams: readonly TeamRow[]): number {
  if (!teams.length) return 0;
  const byId = new Map(teams.map((t) => [t.id, t]));
  let changed = 0;
  for (const b of bots) {
    if (!b?.id) continue;
    const teamId = teamIdFor(b, teams);
    const team = teamId ? byId.get(teamId) : undefined;
    if (!team) continue;
    const role = teamRoleFor(b, team);
    if (b.teamId !== teamId || b.teamRole !== role) {
      b.teamId = teamId;
      b.teamRole = role;
      changed += 1;
    }
  }
  return changed;
}

/** The lead of a team among its members: `chiefId` first, then a member with the chief role. */
export function leadOf<T extends TeamFieldsBot>(team: TeamRow | null | undefined, members: readonly T[]): T | undefined {
  if (!team) return undefined;
  return (
    (team.chiefId ? members.find((b) => b.id === team.chiefId) : undefined) ||
    members.find((b) => b.teamRole === "chief")
  );
}
