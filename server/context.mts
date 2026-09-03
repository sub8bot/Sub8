import fs from "node:fs/promises";
import path from "node:path";
import { appRoot } from "./paths.mjs";
import * as vault from "./vault.mjs";
import * as teams from "./teams.mjs";
import * as store from "@sub8/store";
import * as memory from "./memory.mjs";
import type { MemoryBot, MemoryBotVm } from "./memory.mjs";

/** Only the settings fields this module reads. The real record is far wider. */
export interface ContextSettings {
  userTimeZoneOverride?: string | undefined;
  harness?: { provider?: string | undefined; model?: string | undefined } | undefined;
}

/**
 * Only the bot fields this module reads. Extends MemoryBot rather than
 * redeclaring the overlap, so a bot that satisfies this is accepted by
 * memory.promptBlock() below without a structural cast — and so the two cannot
 * drift apart the way two hand-kept copies would.
 */
export interface ContextBot extends MemoryBot {
  harness?: { provider?: string | undefined; model?: string | undefined } | undefined;
  vm?:
    | (MemoryBotVm & {
        display?: string | undefined;
        setup?: { ready?: boolean | undefined; step?: number | undefined; total?: number | undefined; label?: string | undefined } | undefined;
      })
    | undefined;
}

/** A timezone prefix and the locale/currency/region it implies. Fixed-length so
 *  index access below stays defined under noUncheckedIndexedAccess. */
type TzHint = readonly [RegExp, string, string, string];

const TZ_HINTS: readonly TzHint[] = [
  [/^America\//, "en-US", "USD", "United States"],
  [/^Pacific\/Honolulu/, "en-US", "USD", "United States"],
  [/^Europe\/London/, "en-GB", "GBP", "United Kingdom"],
  [/^Europe\/Dublin/, "en-IE", "EUR", "Ireland"],
  [/^Europe\//, "en-GB", "EUR", "Europe"],
  [/^Asia\/Tokyo/, "ja-JP", "JPY", "Japan"],
  [/^Asia\/Seoul/, "ko-KR", "KRW", "South Korea"],
  [/^Asia\/Shanghai|^Asia\/Hong_Kong/, "zh-CN", "CNY", "China"],
  [/^Asia\/Singapore/, "en-SG", "SGD", "Singapore"],
  [/^Asia\/Bangkok/, "th-TH", "THB", "Thailand"],
  [/^Australia\//, "en-AU", "AUD", "Australia"],
  [/^Pacific\/Auckland/, "en-NZ", "NZD", "New Zealand"],
  [/^Africa\/Johannesburg/, "en-ZA", "ZAR", "South Africa"],
];

export function resolveZone(settings?: ContextSettings | null | undefined): string {
  const raw =
    settings?.userTimeZoneOverride ||
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "America/New_York";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return "America/New_York";
  }
}

export function localeForZone(zone: string): { locale: string; currency: string; region: string } {
  const hit = TZ_HINTS.find(([re]) => re.test(zone));
  if (hit) return { locale: hit[1], currency: hit[2], region: hit[3] };
  return { locale: "en-US", currency: "USD", region: "United States" };
}

function fmt(zone: string, locale: string, date: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, ...opts }).format(date);
}

function ymd(zone: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateFromYmd(ymdStr: string): Date {
  // Erase-only cast. Every caller passes a value produced by ymd() above, which
  // is en-CA and therefore always Y-M-D. A malformed string still yields NaN
  // exactly as before rather than being rejected here.
  const [y, m, d] = ymdStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysYmd(ymdStr: string, days: number): string {
  const dt = dateFromYmd(ymdStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function clockBlock(settings: ContextSettings = {}, { hidden = false }: { hidden?: boolean } = {}): string {
  const zone = resolveZone(settings);
  const { locale, currency, region } = localeForZone(zone);
  const now = new Date();
  const today = ymd(zone, now);
  const tomorrowYmd = addDaysYmd(today, 1);
  const when = fmt(zone, locale, now, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  const tomorrow = fmt("UTC", locale, dateFromYmd(tomorrowYmd), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lines = [
    "## Now",
    `${when} (${zone}).`,
    `Today is ${today}. Tomorrow is ${tomorrow} (${tomorrowYmd}).`,
    `Locale: ${region}, ${locale}. Currency: ${currency}. Use this for prices, dates, and sites unless the user says otherwise.`,
    `The computer itself may be on UTC. Always report times in ${zone} and name the zone.`,
  ];
  if (hidden) {
    lines.push(
      "This turn is a scheduled routine fire, not a new user message. Stay quiet if nothing material changed.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function harnessLine(settings: ContextSettings | null | undefined, bot: ContextBot | null | undefined): string {
  const local = bot?.harness || {};
  const global = settings?.harness || {};
  const provider = local.provider && local.provider !== "default" ? local.provider : global.provider || "grok-build";
  const model = (local.model && String(local.model).trim()) || (global.provider === provider ? global.model : "") || "";
  const names: Record<string, string> = {
    "grok-build": "Grok Build",
    hermes: "Hermes",
    claude: "Claude",
    codex: "Codex",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    spacexai: "SpaceXAI",
  };
  const label = names[provider] || provider;
  return model ? `You are running as ${label} (${model}) on this Bot's Linux computer.` : `You are running as ${label} on this Bot's Linux computer.`;
}

export async function readPrompt(name: string): Promise<string> {
  return fs.readFile(path.join(appRoot, "prompts", name), "utf8");
}

// memory.promptBlock takes a required bot and reads bot.id through agentRoot()
// with no guard, so calling either of these without a bot throws in there — and
// did before this file was typed too. The type cannot say `bot` is required
// while the parameter object still defaults to `{}`, so the `as ContextBot`
// records the real contract without changing the emitted call.
//
// Audited rather than assumed: all three call sites pass the bot whose turn it
// is — agent.mjs:299 (loadSystemPrompt takes it positionally), agent.mjs:1959
// (after the box is resolved for that bot), and host-cli runHostCli({bot}).
// None can reach here with it absent. If a fourth ever can, guard there.
export async function liveContext({ bot, settings, hidden = false }: { bot?: ContextBot | undefined; settings?: ContextSettings | undefined; hidden?: boolean } = {}): Promise<string> {
  const ident = `You are the Bot named "${bot?.name || "Bot"}". ${bot?.description || ""}`.trim();
  const extra = bot?.instructions?.trim() ? `\n\n## Standing instructions for this Bot\n${bot.instructions.trim()}\n` : "";
  const setup = bot?.vm?.setup;
  const boot =
    bot?.vm?.status === "starting" || (setup && setup.ready === false)
      ? `\nThe Linux computer is still bootstrapping${
          setup?.step
            ? ` (step ${setup.step} of ${setup.total}: ${setup.label})`
            : ""
        }. Do not open Chrome or sign in until setup says ready.\n`
      : "";
  return `${clockBlock(settings, { hidden })}
${harnessLine(settings, bot)}
${ident}
${boot}${extra}
${await memory.promptBlock(bot as ContextBot)}`;
}

export async function teamDeskPrompt(bot: ContextBot | null | undefined): Promise<string> {
  if (!bot?.teamId) return "";
  const team = await teams.getTeam(bot.teamId);
  if (!team) return "";
  const mates = teams.membersOf(team, await store.loadBots());
  const lead = bot.teamRole === "chief";
  const rows = mates
    .map((b: { id?: string | undefined; name?: string | undefined; teamRole?: string | undefined; description?: string | undefined; channelState?: string | undefined }) => {
      const you = b.id === bot.id ? " ← you" : "";
      const role = b.teamRole === "chief" ? "lead" : b.teamRole || "member";
      const job = String(b.description || "").trim();
      const held = b.channelState === "hold" ? " · on hold" : "";
      return `- ${b.name} (${role}, id ${b.id})${you}${held}${job ? ` — ${job.slice(0, 120)}` : ""}`;
    })
    .join("\n");
  const mine = bot.vm?.display || ":1";
  const job = String(bot.description || "").trim();
  // One principle each; the model works out the cases. Tools do the plumbing:
  // message_teammate hands work to one teammate (shows in the channel as a
  // delegation line and starts their turn); send_message is the only thing
  // the user sees; a worker's final message is its answer and is delivered.
  const role = lead
    ? [
        `You lead team “${team.name}”. The user talks to you in the team channel; the whole team sees it.`,
        "Answer yourself what you can — a question, a greeting, a quick fact. Hand a piece of work that needs a teammate's hands to them with message_teammate, in the user's words — that appears in the channel as a delegation line and starts their turn. Their answer appears in the channel on its own and is reported to you.",
        "Your final message is your reply to the user. On a turn where you hand work off, the delegation line is your reply and your closing text is NOT shown to the user — so if they also asked YOU something directly (“and tell me yourself…”), answer that part with send_message in the same turn; a closing sentence will not reach them. When a teammate reports back (“Nova replies: …”), the user already sees it in the channel: speak only if you add something — a combined answer, a next step, an unblock — and otherwise call the nothing_to_add tool (never write its name as text), which ends your turn quietly. Do not acknowledge or restate these instructions.",
        "Create teammates when the work needs more hands (create_teammate) and close them when it is done (delete_teammate). set_job only for multi-step work the user will want to track.",
      ]
    : [
        `You are on team “${team.name}”${job ? ` as ${job}` : ""}. Your lead is ${mates.find((m: { teamRole?: string | undefined; name?: string | undefined }) => m.teamRole === "chief")?.name || "the lead"}; the user talks to the lead, and the lead hands you work.`,
        "When the lead sends you something (“Bot (your lead): …”), do it — answer it, or do it on your screen if it needs the computer. Your final message is your answer: it is delivered to the lead and shown in the team channel for you, so make it the answer itself, not a status. To reach the lead or a teammate directly, message_teammate them.",
      ];
  return [
    "",
    "## Team — one computer, many screens",
    ...role,
    "Teammates:",
    rows || "- (none)",
    `All of you share ONE Linux computer: same disk, same \`/config\`; \`/config/workspace/\` is shared. Each Bot has its own X display and Chrome tab — yours is ${mine}. Never touch a teammate's display; never open a new tab. Web pages: the browser tool; pixels and dialogs: the computer tool. Do not reboot or reinstall as if this computer were yours alone.`,
    "A lead can put a teammate on hold (hold_teammate / resume_teammate); on hold, do not act on channel traffic. If you need the user to confirm, pick, or grant access, call ask_user and wait.",
    "Do not invent extra files as deliverables. Google URLs: add &hl=en&gl=us&curr=USD.",
    "",
  ].join("\n");
}

// vault.promptBlock takes a required string. `bot?.id` is passed through as-is
// with an erase-only cast rather than `|| ""`, because that would change what
// vault receives for a bot with no id; the emitted call is byte-identical.
export async function agentsExtra({ bot, settings, hidden = false }: { bot?: ContextBot | undefined; settings?: ContextSettings | undefined; hidden?: boolean } = {}): Promise<string> {
  const ident = `You are the Bot named "${bot?.name || "Bot"}". ${bot?.description || ""}`.trim();
  const extra = bot?.instructions?.trim() ? `\nStanding instructions:\n${bot.instructions.trim()}` : "";
  return `${clockBlock(settings, { hidden })}
${harnessLine(settings, bot)}
${ident}${extra}
${await teamDeskPrompt(bot)}
${await memory.promptBlock(bot as ContextBot)}
${await vault.promptBlock(bot?.id as string)}
`;
}
