import fs from "node:fs/promises";
import path from "node:path";
import { appRoot } from "./paths.mjs";
import * as vault from "./vault.mjs";
import * as teams from "./teams.mjs";
import * as store from "./store.mjs";
import * as memory from "./memory.mjs";

const TZ_HINTS = [
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

export function resolveZone(settings) {
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

export function localeForZone(zone) {
  const hit = TZ_HINTS.find(([re]) => re.test(zone));
  if (hit) return { locale: hit[1], currency: hit[2], region: hit[3] };
  return { locale: "en-US", currency: "USD", region: "United States" };
}

function fmt(zone, locale, date, opts) {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, ...opts }).format(date);
}

function ymd(zone, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateFromYmd(ymdStr) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysYmd(ymdStr, days) {
  const dt = dateFromYmd(ymdStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function clockBlock(settings = {}, { hidden = false } = {}) {
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
  ];
  if (hidden) {
    lines.push(
      "This turn is a scheduled routine fire, not a new user message. Stay quiet if nothing material changed.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function harnessLine(settings, bot) {
  const local = bot?.harness || {};
  const global = settings?.harness || {};
  const provider = local.provider && local.provider !== "default" ? local.provider : global.provider || "grok-build";
  const model = (local.model && String(local.model).trim()) || (global.provider === provider ? global.model : "") || "";
  const names = {
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

export async function readPrompt(name) {
  return fs.readFile(path.join(appRoot, "prompts", name), "utf8");
}

export async function liveContext({ bot, settings, hidden = false } = {}) {
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
${await memory.promptBlock(bot)}`;
}

export async function teamDeskPrompt(bot) {
  if (!bot?.teamId) return "";
  const team = await teams.getTeam(bot.teamId);
  if (!team) return "";
  const mates = teams.membersOf(team, await store.loadBots());
  const role = bot.teamRole === "chief" ? "chief" : "worker";
  const mine = `Sub8:${String(bot.id).slice(0, 8)}`;
  const rows = mates
    .map((b) => {
      const win = `Sub8:${String(b.id).slice(0, 8)}`;
      const you = b.id === bot.id ? " ← you" : "";
      return `- ${b.teamRole || "member"} ${b.name} (${b.id}, Chrome “${win}”)${you}`;
    })
    .join("\n");
  const job =
    role === "chief"
      ? "Assign work with message_teammate. Do not hog the mouse if a worker is mid-task."
      : "Take assignments from the chief. Report back with message_teammate. Drive only your Chrome window.";
  return [
    "",
    "## Team — one shared computer",
    `You are the ${role} on team “${team.name}”. You are NOT on your own machine.`,
    "The whole team shares ONE Linux computer: same disk, same `/config` home, same desktop, same Chrome install. Files you write are immediately visible to teammates. `/config/workspace/` is the shared working folder. Each Bot also has a private notes folder: `/config/agent-data/agents/<id>/`.",
    "Do not reboot, reset, or reinstall as if this computer were yours alone. Do not close a teammate's Chrome window. Yours is titled “" + mine + "”.",
    "One pair of hands on the GUI at a time. Coordinate with message_teammate before taking the desk.",
    job,
    "Teammates:",
    rows || "- (none)",
    "User messages in this thread are the team chat. send_message is visible to the human and the team. If you need the user to confirm, pick an option, or grant access, call ask_user and wait.",
    "",
  ].join("\n");
}

export async function agentsExtra({ bot, settings, hidden = false } = {}) {
  const ident = `You are the Bot named "${bot?.name || "Bot"}". ${bot?.description || ""}`.trim();
  const extra = bot?.instructions?.trim() ? `\nStanding instructions:\n${bot.instructions.trim()}` : "";
  return `${clockBlock(settings, { hidden })}
${harnessLine(settings, bot)}
${ident}${extra}
${await teamDeskPrompt(bot)}
${await memory.promptBlock(bot)}
${await vault.promptBlock(bot?.id)}
`;
}
