#!/usr/bin/env node
/**
 * Host MCP for Claude / Codex. Tools only reach the bot Linux desktop, never this Mac.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "@sub8/store";
import * as vm from "./vm.mjs";
import * as vault from "./vault.mjs";
import * as routines from "@sub8/automations";
import * as teams from "./teams.mjs";
import { resolveZone } from "./context.mjs";
import * as memory from "./memory.mjs";
import { tryCloudStateTool } from "./desk-harness/mcp-cloud.mjs";
import {
  CODE_AGENT_ACTIONS,
  launchCodeAgent,
  listCodeAgents,
  getCodeAgent,
  replyCodeAgent,
  cancelCodeAgent,
  deleteCodeAgent,
} from "./code-agent.mjs";
import { handleUpdateState } from "./update-state.mjs";
import { requestBoxHelp } from "@sub8/control";
import { readFile } from "./read-file.mjs";
import { webFetch } from "@sub8/web-fetch";
import * as channels from "@sub8/store/channels";
import { syncChannelDesk } from "./channel-desk.mjs";
import * as subagents from "./subagents.mjs";
import { cardFromSendMessageArgs, AWAITING_BLOCKED } from "@sub8/choice";
import { sendToAgent, sendToAgentContent } from "./teammate.mjs";
import * as bgShell from "@sub8/shell-exec";
import * as mcpRemote from "@sub8/web-fetch/mcp-remote";

import type { Bot, BotVm, Message, StoredRoutine } from "@sub8/store";
import type { RoutineSpec } from "@sub8/automations";
import type { ChoiceCard } from "@sub8/choice";
import type { ShellView } from "@sub8/shell-exec";
import type { ContextSettings } from "./context.mjs";
import type { MemoryRoutine } from "./memory.mjs";
import type { JobStepSeed, TaskStatus } from "./teams.mjs";

/**
 * One JSON-Schema node inside a tool's `inputSchema`. Open on purpose: this is
 * the subset of JSON Schema the specs below actually spell, and it is handed to
 * the model verbatim.
 */
export interface ToolParameterSchema {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: readonly string[];
}

/** One entry of TOOLS, in the MCP `tools/list` shape. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ToolParameterSchema;
}

/** One MCP content block. Text and a base64 screenshot are the only two kinds. */
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** What every tool hands back to the harness. */
export interface McpResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Tool arguments exactly as the model sent them: JSON off the wire, so a field
 * is a claim and not a fact. Anything a branch coerces itself stays `unknown`;
 * only what is forwarded straight into a typed callee is spelled tighter.
 */
export type ToolArgs = {
  caption?: unknown;
  action?: string | undefined;
  x?: unknown;
  y?: unknown;
  dx?: number | undefined;
  dy?: number | undefined;
  ms?: number | undefined;
  text?: string | undefined;
  keys?: string | undefined;
  ref?: unknown;
  url?: string | undefined;
  command?: unknown;
  block_until_ms?: unknown;
  path?: string | undefined;
  content?: string | undefined;
  /** send_message: teammates to wake (names or ids). */
  to?: unknown;
  once_at?: unknown;
  message?: unknown;
  reason?: unknown;
  id?: string | undefined;
  prompt?: string | undefined;
  repoUrl?: string | undefined;
  repo_url?: string | undefined;
  branch?: string | undefined;
  cwd?: string | undefined;
  images?: string[] | undefined;
  account_id?: string | undefined;
  field?: string | undefined;
  target?: unknown;
  name?: string | undefined;
  instruction?: unknown;
  interval_minutes?: unknown;
  schedule?: unknown;
  group_key?: string | undefined;
  force_new?: unknown;
  force_replace?: unknown;
  solo?: unknown;
  replace?: unknown;
  enabled?: boolean | undefined;
  type?: unknown;
  question?: unknown;
  hint?: unknown;
  choices?: unknown;
  allow_custom?: unknown;
  widget?: unknown;
  secret?: unknown;
  bot_id?: string | undefined;
  label?: unknown;
  status?: unknown;
  detail?: unknown;
  step_id?: string | undefined;
  title?: unknown;
  steps?: JobStepSeed[] | undefined;
  job?: unknown;
  role?: unknown;
  harness?: unknown;
  provider?: unknown;
  model?: unknown;
  instructions?: unknown;
  description?: unknown;
  color?: unknown;
  all_workers?: unknown;
  query?: unknown;
  member_ids?: unknown;
  add_id?: unknown;
  remove_id?: unknown;
  channel_id?: string | undefined;
  server_id?: string | undefined;
  tool?: unknown;
  arguments?: unknown;
  args?: unknown;
  headers?: Record<string, unknown> | undefined;
};

/**
 * The stored bot row as the desk modules want it spelled.
 *
 * Not one new field on disk. `@sub8/store` types `vm.container` as
 * `string | null | undefined` and leaves `computerId`, `harnessPort`,
 * `backgroundShells` and `awaitingUserSelection` under its index signature,
 * while `server/vm.mts`, `server/code-agent.mts`, `@sub8/shell-exec` and
 * `server/memory.mts` each spell their own slice without the `null`. The same
 * object satisfies all of them at runtime; only the optional-property spelling
 * differs, so the `as McpBot` below restate what each caller already checked and
 * emit no instruction.
 */
type McpBot = Bot & {
  name?: string;
  vm?: BotVm & { container?: string; status?: string; computerId?: string; harnessPort?: number; hostHarnessPort?: number };
  routines?: (StoredRoutine & MemoryRoutine)[];
  backgroundShells?: ShellView[];
  awaitingUserSelection?: boolean | undefined;
};

/** An `McpBot` that `botOrThrow` proved has a running computer with a container. */
type DeskBotRow = McpBot & { vm: BotVm & { container: string } };

/**
 * What this file reads off a `sendToAgent` result. The package's union splits
 * `channelId` and `botId` between its room arm and its peer arm; each branch
 * below already knows which one it took and prints only that one.
 */
interface RoutedSend {
  queued: number;
  channelId?: string | undefined;
  botId?: string | undefined;
}

/**
 * A choices card on its way into the stored message list. `@sub8/choice` models
 * the card as an interface, so it picks up no implicit index signature and does
 * not satisfy `@sub8/store`'s `Message`, which has one. The same object reaches
 * the store either way; only the two declarations disagree about the spelling.
 */
type StoredCard = ChoiceCard & Message;

/** One JSON-RPC line off stdin. The harness writes it, so nothing is proven. */
interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: ToolArgs | undefined } | undefined;
}

// routines.mjs used to reach for vm.mjs with a lazy import; @sub8/automations
// takes the desk filesystem by injection instead.
routines.setAutomationWriter(vm);

const botId = process.env.SUB8BOT_BOT_ID || "";
const token = process.env.SUB8_INTERNAL_TOKEN || "";
const emitUrl = process.env.SUB8_INTERNAL_URL || "";

/** Spec / grok-bot names → Sub8 MCP tool names. Same map as @sub8/orchestration TOOL_ALIASES. */
export const MCP_ALIASES: Record<string, string> = {
  SendMessage: "send_message",
  SendToAgent: "message_teammate",
  CreateAgent: "create_teammate",
  CreateChannel: "create_channel",
  UpdateChannel: "update_channel",
  Task: "task",
  CheckSubagent: "check_subagent",
  MessageSubagent: "message_subagent",
  StopSubagent: "stop_subagent",
  CloudAgent: "cloud_agent",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  Screenshot: "computer",
  RequestBoxHelp: "request_box_help",
  Read: "read",
  AwaitShell: "await_shell",
  AskUser: "ask_user",
  Shell: "shell",
  UpdateState: "update_state",
  GetMcpTools: "get_mcp_tools",
  CallMcpTool: "call_mcp_tool",
  AuthenticateMcpServer: "authenticate_mcp_server",
  AddMcpServer: "add_mcp_server",
};

export function canonicalMcpName(name: unknown): string {
  const raw = String(name ?? "");
  return MCP_ALIASES[raw] || raw;
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function emit(event: string, data: unknown): Promise<void> {
  if (!emitUrl || !token || !botId) return;
  try {
    await fetch(`${emitUrl}/api/internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sub8-token": token },
      body: JSON.stringify({ botId, event, data }),
    });
  } catch {
    /* UI notify is best-effort */
  }
}

async function endTurnKeepBot(): Promise<void> {
  if (!emitUrl || !token || !botId) return;
  try {
    await fetch(`${emitUrl}/api/internal/end-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sub8-token": token },
      body: JSON.stringify({ botId }),
    });
  } catch {
    /* best-effort */
  }
}

export const TOOLS: ToolSpec[] = [
  {
    name: "computer",
    description:
      "Pixel desktop. Prefer browser for web pages. Screenshot/click x,y on the last 1024x768 image, native dialogs, drag. type pastes exact text (URLs keep ://). key is Return/ctrl+l — never send a URL via key.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "left_click",
            "right_click",
            "double_click",
            "type",
            "key",
            "scroll",
            "wait",
            "open",
            "mouse_move",
          ],
        },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        keys: { type: "string" },
        dy: { type: "number" },
        dx: { type: "number" },
        ms: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser",
    description:
      "Drive this Bot's Chrome tab by page structure. snapshot, click ref, fill ref, select ref+text for dropdowns, navigate URL. Prefer over computer clicks on websites.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snapshot", "click", "fill", "select", "navigate", "press", "wait"] },
        ref: { type: "number" },
        text: { type: "string" },
        url: { type: "string" },
        keys: { type: "string" },
        ms: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside the bot Linux desktop (home /config). Files, apt, desk-doctor. Not the host Mac. Do not click, type, or drive Chrome from the shell. block_until_ms=0 backgrounds; poll with await_shell. Alias: Shell.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, block_until_ms: { type: "number" } },
      required: ["command"],
    },
  },
  {
    name: "memory",
    description:
      "Read or write lasting notes on my computer under /config/agent-data and /config/workspace. Not HTTP. Use for durable facts and repeating-job history.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "append", "list"] },
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "update_state",
    description:
      "Change this Bot's lasting state: memory, routines, skills, profile, or projects. Prefer this over hand-editing files. avatar, settings, and channel are not wired yet.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["memory", "routine", "skill", "profile", "settings", "project", "avatar", "channel"],
        },
        action: { type: "string" },
        scope: { type: "string", enum: ["agent", "user", "project"] },
        tier: { type: "string", enum: ["profile", "log", "note"] },
        slug: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        instruction: { type: "string" },
        prompt: { type: "string" },
        schedule: {},
        interval_minutes: { type: "number" },
        body: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["target", "action"],
    },
  },
  {
    name: "vault_list",
    description: "List saved logins this Bot may use. Never includes passwords.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault_fill",
    description: "Paste a saved username or password into the focused desktop field. Never prints the secret.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        field: { type: "string", enum: ["username", "password"] },
      },
      required: ["account_id", "field"],
    },
  },
  {
    name: "list_routines",
    description: "List this Bot's standing routines (id, name, interval, instruction).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upsert_routine",
    description:
      "Create or UPDATE this Bot's standing routine — or, with once_at, a ONE-OFF reminder (its own job, fires once; use it for 'remind me in N minutes/at HH:MM'). Pass id from list_routines to edit. The operator asking to change the routine is permission. Do not create a second job that overlaps (same group or similar interval); update the existing id. instruction must be the full standing brief. For every morning, pass schedule {type:\"daily\", hour:9, minute:0} and omit interval_minutes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        instruction: { type: "string" },
        interval_minutes: { type: "number" },
        once_at: { type: "string", description: "ISO-8601 time for a ONE-OFF reminder ('remind me in 2 minutes' → now + 2 min). Creates a separate job that fires once; never claim a reminder is set without this." },
        schedule: {
          type: "object",
          properties: { type: { type: "string" }, hour: { type: "number" }, minute: { type: "number" } },
        },
        group_key: { type: "string" },
        force_new: { type: "boolean" },
        force_replace: { type: "boolean" },
        enabled: { type: "boolean" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "disable_routine",
    description: "Turn off a standing routine by id (keeps it; re-enable later). Use for pause/stop.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_routine",
    description: "Permanently remove a routine by id. Use when the user says delete/remove/get rid of a routine (not just pause).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "show_user",
    description: "Post a screenshot of your screen INTO the chat so the user actually sees it. Use it at meaningful moments only — a finished page/app/result to show off, a blocker or error you need them to see, or a critical state before an irreversible action. NOT for routine looks (use computer screenshot for those). Optional caption explains what they are looking at.",
    inputSchema: {
      type: "object",
      properties: { caption: { type: "string", description: "One line telling the user what this screenshot shows." } },
    },
  },
  {
    name: "list_teammates",
    description: "List the other Bots on your team (id, name, role).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nothing_to_add",
    description: "A teammate's report needs no reply from you — the user already sees it in the channel. Call this to end your turn quietly. Do not write a closing remark instead.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description:
      "Your only voice to the user. type=text result. type=widget asks and ENDS the turn. type=secret-request masked credential, ENDS the turn. In a team the whole team sees it too; pass to (names or ids) to wake specific teammates. A worker's answer to the lead is its final message, not a send_message.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["text", "widget", "secret-request", "attachment"] },
        content: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        question: { type: "string" },
        hint: { type: "string" },
        choices: { type: "array", items: { type: "object" } },
        allow_custom: { type: "boolean" },
        widget: { type: "object" },
        secret: { type: "object" },
      },
    },
  },
  {
    name: "web_search",
    description: "Search the live web. Alias: WebSearch.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: "Fetch a public URL as text. Alias: WebFetch.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "read",
    description: "Read a file under /config. Alias: Read.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "create_channel",
    description: "Create a chat room. Alias: CreateChannel.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, member_ids: { type: "array", items: { type: "string" } }, description: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "update_channel",
    description: "Add or remove a room member. Alias: UpdateChannel.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" }, add_id: { type: "string" }, remove_id: { type: "string" } },
      required: ["channel_id"],
    },
  },
  {
    name: "task",
    description: "Spawn a background worker. Alias: Task.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string" }, prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
  {
    name: "check_subagent",
    description: "List or get a Task. Alias: CheckSubagent.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "message_subagent",
    description: "Steer a running Task. Alias: MessageSubagent.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] },
  },
  {
    name: "stop_subagent",
    description: "Abort a Task. Alias: StopSubagent.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "await_shell",
    description: "Wait on a background shell. Alias: AwaitShell.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "message_teammate",
    description:
      "SendToAgent: fire-and-forget a note to a bot UUID or a room UUID. Pass bot_id from list_teammates, create_teammate, or create_channel. Never invent a UUID. Do not pass status=running on a step that is already done — that is a follow-up note, not a restart.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        content: { type: "string" },
        label: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "done", "blocked", "looping"] },
        detail: { type: "string" },
      },
      required: ["bot_id", "content"],
    },
  },
  {
    name: "list_tasks",
    description: "Show the team job and step statuses.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_job",
    description: "Chief: set the team progress-bar job.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        steps: { type: "array", items: { type: "object" } },
      },
      required: ["title", "steps"],
    },
  },
  {
    name: "update_task",
    description: "Update your job step: pending, running, done, blocked, looping.",
    inputSchema: {
      type: "object",
      properties: {
        step_id: { type: "string" },
        label: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "done", "blocked", "looping"] },
        detail: { type: "string" },
      },
      required: ["status"],
    },
  },
  {
    name: "ask_user",
    description: "Alias of send_message type=widget. Ends the turn. Prefer send_message widget.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        hint: { type: "string" },
        choices: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } },
        },
        allow_custom: { type: "boolean" },
      },
      required: ["question"],
    },
  },
  {
    name: "create_teammate",
    description:
      "Create another Bot on THIS shared desk with its own Chrome/screen. Pass name and job — take the job from the user's words; a missing job defaults to general helper, so never ask what the teammate is for. You MAY set harness (claude, grok-build, hermes, codex, cursor, ollama, lmstudio) and model. Returns id= — pass that to message_teammate. Never invent ids.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        job: { type: "string" },
        role: { type: "string" },
        harness: { type: "string" },
        model: { type: "string" },
        instructions: { type: "string" },
        color: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_bot",
    description:
      "Change ONLY the display name of yourself or a teammate. It sets nothing else — their job and description are untouched, and anything else you pass is ignored. This does NOT deliver messages: use message_teammate to say something to a teammate.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        name: { type: "string", description: "The new short display name, e.g. Scout. Never message text." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_bot",
    description:
      "Change harness, model, instructions, description, color, or role for yourself or a teammate, when the user asked for that settings change. This does NOT deliver messages — message_teammate does — and never copy message text into name/description/instructions: writing one string into all of them wipes the teammate and is refused.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        name: { type: "string", description: "New short display name. Never message text." },
        harness: { type: "string" },
        model: { type: "string" },
        instructions: {
          type: "string",
          description: "Replaces their standing job in full. Leave unset unless the user asked to change what this Bot does.",
        },
        description: {
          type: "string",
          description: "Replaces the one-line 'who this Bot is'. Leave unset unless the user asked to change it.",
        },
        color: { type: "string" },
        role: { type: "string" },
      },
    },
  },
  {
    name: "hold_teammate",
    description: "Park a teammate: pause them so they stop acting on team-channel @mentions/keywords until you resume_teammate them. Chief use. Pass bot_id from list_teammates.",
    inputSchema: { type: "object", properties: { bot_id: { type: "string", description: "Worker id from list_teammates." } }, required: ["bot_id"] },
  },
  {
    name: "resume_teammate",
    description: "Un-park a teammate paused with hold_teammate so they wake on channel traffic again. Pass bot_id.",
    inputSchema: { type: "object", properties: { bot_id: { type: "string", description: "Worker id from list_teammates." } }, required: ["bot_id"] },
  },
  {
    name: "delete_teammate",
    description:
      "Close/remove worker bots when the user asks (close all bots, delete teammates, etc). all_workers=true closes every worker except you. Or pass bot_id from list_teammates. Never delete yourself. This is not a job — do not set_job or message_teammate someone to close bots.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "One worker id from list_teammates. Ignored when all_workers=true." },
        all_workers: {
          type: "boolean",
          description: "true = close every worker on this desk except you. Use this for 'close all bots'.",
        },
      },
    },
  },
  {
    name: "cloud_agent",
    description:
      "Coding session on THIS desk (same computer, same /config). launch starts work in cwd under /config; list/get/reply/cancel/delete the session. Does not create a computer. Alias: CloudAgent.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...CODE_AGENT_ACTIONS] },
        prompt: { type: "string" },
        repoUrl: { type: "string" },
        repo_url: { type: "string" },
        branch: { type: "string" },
        cwd: { type: "string" },
        id: { type: "string" },
        message: { type: "string" },
        content: { type: "string" },
        images: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
  },
  {
    name: "add_mcp_server",
    description: "Add a remote HTTPS MCP. Not a marketplace. Alias: AddMcpServer.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, url: { type: "string" }, headers: { type: "object" } },
      required: ["name", "url"],
    },
  },
  {
    name: "get_mcp_tools",
    description: "List tools on a user-added remote MCP. Alias: GetMcpTools.",
    inputSchema: { type: "object", properties: { server_id: { type: "string" } }, required: ["server_id"] },
  },
  {
    name: "call_mcp_tool",
    description: "Call a tool on a user-added remote MCP. Alias: CallMcpTool.",
    inputSchema: {
      type: "object",
      properties: { server_id: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } },
      required: ["server_id", "tool"],
    },
  },
  {
    name: "authenticate_mcp_server",
    description: "Masked connect card; ends the turn. Alias: AuthenticateMcpServer.",
    inputSchema: { type: "object", properties: { server_id: { type: "string" } }, required: ["server_id"] },
  },
  {
    name: "request_box_help",
    description:
      "Ask the human to press Take control for login, 2FA, captcha, or payment. You never see their password. Does not grant this Mac's filesystem (External* is out). Alias: RequestBoxHelp.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" }, message: { type: "string" } },
    },
  },
];

async function botOrThrow(): Promise<DeskBotRow> {
  const bot = await store.getBot(botId);
  if (!bot) throw new Error("Bot not found");
  if (bot.vm?.status !== "running" || !bot.vm.container) throw new Error("Computer is not running yet.");
  const displayOverride = Number(process.env.SUB8_DISPLAY || 0);
  if (displayOverride > 0) bot.vm = { ...bot.vm, display: `:${displayOverride}` };
  // The two throws above ARE `DeskBotRow` stated as a type: a running computer
  // with a non-empty container. TypeScript cannot carry a narrowing on
  // `bot.vm.container` back onto `bot` itself, and the assertion emits nothing.
  return bot as DeskBotRow;
}

async function runComputer(args: ToolArgs): Promise<McpResult> {
  const bot = await botOrThrow();
  const action = args.action;
  await emit("tool", { name: "computer", args });
  if (action === "screenshot") {
    const shot = await vm.screenshot(bot);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "screenshot",
      summary: "Looked at the screen",
      ts: Date.now(),
    });
    return {
      content: [
        { type: "text", text: `Screenshot ${shot.width}x${shot.height}. Coordinates are 1:1, origin top-left.` },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "open") {
    await vm.openChrome(bot, args.text || "");
    await vm.wait(1200);
    await emit("message", {
      id: `tl${Date.now()}mcp`,
      role: "activity",
      kind: "tool",
      name: "computer",
      action: "open",
      summary: "Opened Chrome",
      ts: Date.now(),
    });
    const shot = await vm.screenshot(bot);
    return {
      content: [
        {
          type: "text",
          text: `Opened ${String(args.text || "Chrome").slice(0, 160)}. Screenshot ${shot.width}x${shot.height}. Click the next control or type.`,
        },
        { type: "image", data: shot.buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  }
  if (action === "left_click") await vm.click(bot, args.x, args.y, 1, 1);
  else if (action === "right_click") await vm.click(bot, args.x, args.y, 3, 1);
  else if (action === "double_click") await vm.click(bot, args.x, args.y, 1, 2);
  else if (action === "mouse_move") await vm.mouseMove(bot, args.x, args.y);
  else if (action === "type") await vm.typeText(bot, args.text || "");
  else if (action === "key") await vm.key(bot, args.keys || args.text || "Return");
  else if (action === "scroll") await vm.scroll(bot, args.x, args.y, args.dy || 0, args.dx || 0);
  else if (action === "wait") await vm.wait(args.ms || 800);
  else throw new Error(`unknown action ${action}`);
  await emit("message", {
    id: `tl${Date.now()}mcp`,
    role: "activity",
    kind: "tool",
    name: "computer",
    action,
    // `action` is narrowed past "open" by the early return ~50 lines up, so this
    // arm is dead; widening keeps the comparison compiling without moving it.
    summary: (action as string) === "open" ? "Opened Chrome" : action.replaceAll("_", " "),
    ts: Date.now(),
  });
  return { content: [{ type: "text", text: `${action} ok` }] };
}

async function runBrowser(args: ToolArgs): Promise<McpResult> {
  const bot = await botOrThrow();
  await emit("tool", { name: "browser", args });
  const r = await vm.pageAgent(bot, args);
  await emit("message", {
    id: `tl${Date.now()}br`,
    role: "activity",
    kind: "tool",
    name: "browser",
    action: args.action,
    summary: args.action === "snapshot" ? "Read the page" : `Browser ${args.action}`,
    ts: Date.now(),
  });
  // Redact, exactly as the `shell` handler does. vault_fill pastes a secret
  // into whatever the desktop has focused -- pasteSecret is xdotool-level, so
  // it cannot tell a password field from a plain one -- and page-agent's
  // snapshot emits value="<AX value>" for every textbox. Without this, a model
  // could paste a credential into an ordinary input and read it straight back
  // out of the snapshot, into its own context and the transcript.
  const secrets = await vault.listSecrets();
  return { content: [{ type: "text", text: vault.redactSecrets(r.text || "", secrets) }] };
}

function mcpText(text: unknown, isError: boolean = false): McpResult {
  const out: McpResult = { content: [{ type: "text", text: String(text) }] };
  if (isError) out.isError = true;
  return out;
}

/** In-box coding session on this bot's existing desk. Does not create a computer. */
async function runCloudAgent(args: ToolArgs = {}): Promise<McpResult> {
  const bot = await store.getBot(botId) as McpBot | null;
  if (!bot) throw new Error("Bot not found");
  const action = String(args.action || "").trim();
  if (action === "launch") {
    const launched = await launchCodeAgent(bot, {
      prompt: args.prompt,
      repoUrl: args.repoUrl || args.repo_url,
      branch: args.branch,
      cwd: args.cwd,
      images: args.images,
    });
    await emit("message", {
      id: `tl${Date.now()}ca`,
      role: "activity",
      kind: "tool",
      name: "cloud_agent",
      action: "launch",
      summary: "Started a coding session",
      ts: Date.now(),
    });
    return mcpText(JSON.stringify(launched));
  }
  if (action === "list") {
    const rows = await listCodeAgents(bot);
    return mcpText(rows.length ? JSON.stringify(rows, null, 2) : "No code agent sessions.");
  }
  // get/reply/cancel/delete all address an existing session by id, but this
  // tool's inputSchema marks only `action` required, so a model can legally omit
  // it. Without this guard `get` answered "session not found" — which reads as
  // "that session is gone" and invites a re-launch rather than a retry with the
  // id — while reply/cancel/delete passed undefined straight into code-agent.
  // The schema itself is left alone: making `id` conditionally required needs
  // if/then, and every harness that reads this catalog would have to agree.
  if (["get", "reply", "cancel", "delete"].includes(action) && !String(args.id || "").trim()) {
    return mcpText(`cloud_agent ${action} needs the session id. Use action "list" to see the sessions on this desk.`, true);
  }
  if (action === "get") {
    // `!`: the guard above proves `id` is a non-empty string for these four
    // actions. It satisfies code-agent.mts's `id: string` and emits nothing.
    const row = await getCodeAgent(bot, args.id!);
    if (!row) return mcpText("session not found", true);
    return mcpText(JSON.stringify(row, null, 2));
  }
  if (action === "reply") {
    const row = await replyCodeAgent(bot, args.id!, args.message || args.content);
    return mcpText(JSON.stringify(row));
  }
  if (action === "cancel") {
    const row = await cancelCodeAgent(bot, args.id!);
    await emit("message", {
      id: `tl${Date.now()}ca`,
      role: "activity",
      kind: "tool",
      name: "cloud_agent",
      action: "cancel",
      summary: "Cancelled a coding session",
      ts: Date.now(),
    });
    return mcpText(JSON.stringify(row));
  }
  if (action === "delete") {
    const row = await deleteCodeAgent(bot, args.id!);
    return mcpText(JSON.stringify(row));
  }
  throw new Error(`unknown action ${action}`);
}

/**
 * Is this shell job still going? Two paths come back unfinished and only one of
 * them sets `background`:
 *
 *  - explicitly backgrounded (blockUntilMs <= 0)   -> background: true
 *  - outran its block window                        -> background is UNDEFINED
 *
 * The second path returns `status: "running"` with an empty output. Branching on
 * `background` alone therefore fell through to `ok: status !== "failed"`, which
 * is true for "running", and rendered the empty output as "(ok)" — telling the
 * model a command had succeeded while it was still executing. Pinned upstream by
 * packages/shell-exec/test/shell-failures.test.mjs ("a job that outruns
 * blockUntilMs comes back running").
 */
export function shellJobUnfinished(job: { background?: boolean | undefined; status?: string | undefined } | null | undefined): boolean {
  return Boolean(job?.background) || job?.status === "running";
}

export async function callTool(rawName: unknown, args: ToolArgs = {}): Promise<McpResult> {
  const name = canonicalMcpName(rawName);
  const cloud = await tryCloudStateTool(name, args);
  if (cloud) return cloud;
  if (name === "cloud_agent") return runCloudAgent(args);
  if (name === "request_box_help") {
    const row = requestBoxHelp(botId, { reason: args.reason || args.message || args.content });
    await emit("control", { botId, requestBoxHelp: true, reason: row.reason });
    return mcpText(
      JSON.stringify({
        ok: true,
        action: "take_control",
        reason: row.reason,
        hostFs: false,
        message: "Ask the human to press Take control. You never see their password. External host files are not available.",
      }),
    );
  }
  if (name === "show_user") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    const shot = await vm.screenshot(bot as unknown as vm.DeskBot);
    // Save a UNIQUE copy (vm.screenshot overwrites <bot>.png every look) into
    // the already-served /screens dir, and post it as a real chat message.
    const name2 = `${bot.id}-show-${Date.now()}.png`;
    const dest = path.join(store.dataDir, "screens", name2);
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, shot.buf);
    } catch {
      /* fall back to text-only below */
    }
    const caption = String(args.caption || "").trim();
    const msg = {
      id: `sh${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      role: "assistant",
      content: caption,
      image: `/screens/${name2}`,
      speakerId: bot.id,
      speakerName: bot.name,
      speakerRole: bot.teamRole || undefined,
      ts: Date.now(),
    };
    await store.patchBot(botId, (b) => { b.messages = b.messages || []; b.messages.push(msg as store.Message); });
    await emit("message", { botId, ...msg });
    if (emitUrl && token && (bot as { teamId?: string }).teamId) {
      try {
        await fetch(`${emitUrl}/api/internal/show-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-sub8-token": token },
          body: JSON.stringify({ botId, image: msg.image, content: caption }),
        });
      } catch {
        /* the 1:1 view still has it from bot.messages */
      }
    }
    return { content: [{ type: "text", text: "showed the user a screenshot in the chat" }] };
  }
  if (name === "computer") return runComputer(args);
  if (name === "browser") return runBrowser(args);
  if (name === "shell") {
    const bot = await botOrThrow();
    const secrets = await vault.listSecrets();
    const cmd = String(args.command || "");
    if (secrets.some((s) => s && cmd.includes(s))) {
      return { content: [{ type: "text", text: "Blocked: do not put vault secrets in the shell." }], isError: true };
    }
    await emit("message", {
      id: `tl${Date.now()}sh`,
      role: "activity",
      kind: "tool",
      name: "shell",
      action: "shell",
      summary: `Ran ${cmd.slice(0, 48)}`,
      ts: Date.now(),
    });
    const blockUntilMs = args.block_until_ms == null ? 30_000 : Number(args.block_until_ms);
    const job = await bgShell.startShell({
      botId: bot.id,
      command: cmd,
      blockUntilMs,
      run: async (c) => {
        const r = await vm.shell(bot, c);
        return { ok: r.ok, output: vault.redactSecrets(r.output || "", secrets) };
      },
    });
    bgShell.attachToBot(bot, job);
    await store.upsertBot(bot);
    if (shellJobUnfinished(job)) return { content: [{ type: "text", text: JSON.stringify(job) }] };
    const r = { ok: job.status !== "failed", output: job.output };
    return { content: [{ type: "text", text: vault.redactSecrets(r.output || (r.ok ? "(ok)" : "(failed)"), secrets) }] };
  }
  if (name === "memory") {
    const live = await store.getBot(botId);
    const bot = (live || {
      id: botId || "desk",
      name: "Bot",
      vm: { status: "running" },
    }) as memory.MemoryBot;
    const r = await memory.handleMemory(bot, args);
    await emit("message", {
      id: `tl${Date.now()}mem`,
      role: "activity",
      kind: "tool",
      name: "memory",
      action: String(args.action || "read"),
      summary: args.action === "append" ? "Noted memory" : args.action === "write" ? "Updated memory" : "Read memory",
      ts: Date.now(),
    });
    // Redact: `read` and `memory` were the two sinks the redaction sweep
    // missed, so a credential in any /config file came back verbatim.
    const memText = vault.redactSecrets(r.text || "", await vault.listSecrets());
    return { content: [{ type: "text", text: memText }], isError: r.ok === false };
  }
  if (name === "update_state") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    const r = await handleUpdateState(bot, args, {
      writer: async (dest: string, text: string | null) => {
        if (!bot.vm?.container || bot.vm.status === "missing") {
          throw new Error("Computer is not running yet.");
        }
        if (text == null) {
          // The guard three lines up proved `bot.vm.container`; `DeskBotRow` is
          // that stated as a type. `vm.shell` still runs its own `assertVmShell`
          // isolation check — the assertion only silences the spelling.
          await vm.shell(bot as DeskBotRow, `rm -f ${JSON.stringify(dest)}`);
          return;
        }
        await vm.mkdirpInContainer(bot.vm.container, path.posix.dirname(dest));
        await vm.writeFileToContainer(bot.vm.container, dest, text);
      },
    });
    if (r.persist) await store.upsertBot(bot);
    await emit("message", {
      id: `tl${Date.now()}us`,
      role: "activity",
      kind: "tool",
      name: "update_state",
      action: String(args.action || args.target || "update_state"),
      summary: String(r.text || "Updated state").slice(0, 80),
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: r.text }], isError: r.ok === false };
  }
  if (name === "vault_list") {
    const rows = await vault.grantedAccounts(botId);
    return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No saved logins granted." }] };
  }
  if (name === "vault_fill") {
    const bot = await botOrThrow();
    const filled = await vault.fillIntoDesktop(bot, args.account_id, args.field || "password");
    await emit("message", {
      id: `tl${Date.now()}vf`,
      role: "activity",
      kind: "tool",
      name: "vault_fill",
      action: "vault_fill",
      summary: args.field === "username" ? "Pasted username" : "Pasted password",
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: filled.text }], isError: !filled.ok };
  }
  if (name === "list_routines") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const rows = bot.routines || [];
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "list_routines",
      action: "list_routines",
      summary: "Checked routines",
      ts: Date.now(),
    });
    return {
      content: [
        {
          type: "text",
          text: rows.length ? JSON.stringify(rows, null, 2) : "No standing routines.",
        },
      ],
    };
  }
  if (name === "disable_routine") {
    // Same lock discipline as upsert_routine (see above).
    const box: { row: { id: string; name: string } | null } = { row: null };
    await store.patchBot(botId, (b) => {
      const hit = (b.routines || []).find((x) => x.id === args.id);
      if (!hit) return;
      hit.enabled = false;
      hit.updatedAt = Date.now();
      box.row = { id: String(hit.id), name: String(hit.name || "routine") };
    });
    const r = box.row;
    if (!r) return { content: [{ type: "text", text: "routine not found" }], isError: true };
    await emit("routine", { routine: r });
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "disable_routine",
      action: "disable_routine",
      summary: `Paused ${r.name}`,
      ts: Date.now(),
    });
    return { content: [{ type: "text", text: `disabled ${r.name}` }] };
  }
  if (name === "delete_routine") {
    const box: { row: { id: string; name: string } | null } = { row: null };
    await store.patchBot(botId, (b) => {
      const hit = (b.routines || []).find((x) => x.id === args.id);
      if (!hit) return;
      box.row = { id: String(hit.id), name: String(hit.name || "routine") };
      b.routines = (b.routines || []).filter((x) => x.id !== args.id);
    });
    const r = box.row;
    if (!r) return { content: [{ type: "text", text: "routine not found" }], isError: true };
    await emit("routine", { deleted: r.id });
    await emit("message", { id: `tl${Date.now()}rt`, role: "activity", kind: "tool", name: "delete_routine", action: "delete_routine", summary: `Deleted ${r.name}`, ts: Date.now() });
    return { content: [{ type: "text", text: `deleted ${r.name}` }] };
  }
  if (name === "upsert_routine") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    const minutes = Number(args.interval_minutes);
    const instruction = String(args.instruction || "");
    const settings = await store.loadSettings();
    // `RoutineSpec` spells `id`, `name`, `groupKey`, `intervalMs` and `enabled`
    // without `| undefined`, so under exactOptionalPropertyTypes every absent
    // argument — which is most calls — is an error against a package type we do
    // not own. `upsertRoutine` reads each one with a truthiness or `== null`
    // test, so an explicit `undefined` and an absent key behave identically. The
    // assertion adds no runtime instruction.
    // Mutate under the bots.json lock. getBot → upsertBot was a lost update:
    // the server's own patchBot (tool rows, busy flags) landed after this
    // snapshot and wrote the routine away — the bot "confirmed" a routine that
    // did not exist on its record.
    let result = null as unknown as ReturnType<typeof routines.upsertRoutine>;
    await store.patchBot(botId, (b) => {
      result = routines.upsertRoutine(b as McpBot, {
        id: args.id || undefined,
        name: args.name,
        instruction,
        intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
        schedule: args.schedule,
        groupKey: args.group_key || undefined,
        // One-off reminder: its own job, fires once. The model computes the time.
        triggers: args.once_at ? [{ kind: "once", at: Date.parse(String(args.once_at)) }] : undefined,
        forceNew: args.force_new === true || Boolean(args.once_at),
        solo: args.once_at ? false : args.solo !== false,
        forceReplace: args.force_replace === true || instruction.length > 80,
        replace: args.replace !== false,
        enabled: args.enabled,
        // @sub8/store spells "no override" as `null`; `ContextSettings` spells it
        // as an absent key. `resolveZone` ORs the field with the environment, so
        // both reach the same branch.
        timeZone: resolveZone(settings as ContextSettings),
      } as RoutineSpec);
    });
    const { routine, merged, rejected } = result;
    await emit("routine", { routine, merged, rejected });
    await emit("message", {
      id: `tl${Date.now()}rt`,
      role: "activity",
      kind: "tool",
      name: "upsert_routine",
      action: "upsert_routine",
      summary: rejected ? "Kept the standing brief" : merged ? `Updated ${routine?.name || "routine"}` : `Created ${routine?.name || "routine"}`,
      ts: Date.now(),
    });
    if (rejected) {
      return {
        content: [
          {
            type: "text",
            text: `Did not create a second standing job (a Bot keeps ONE). For a one-off reminder pass once_at (ISO time) — that creates its own job that fires once. ${rejected}. Call upsert_routine with that id to edit.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: merged
            // Non-null: `upsertRoutine` returns `routine: null` only together with
            // `rejected`, and the `if (rejected)` above has already returned.
            ? `Updated "${routine!.name}" (${routine!.id}) ${routines.cadenceLabel(routine).toLowerCase()}.`
            : `Created "${routine!.name}" (${routine!.id}) ${routines.cadenceLabel(routine).toLowerCase()}.`,
        },
      ],
    };
  }
  if (name === "list_teammates") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const mates = await teams.listDeskWorkers(bot);
    return {
      content: [
        {
          type: "text",
          text: mates.length
            ? JSON.stringify(mates.map((b) => ({ id: b.id, name: b.name, role: b.teamRole || "member" })), null, 2)
            : bot.teamId
              ? "No teammates."
              : "You are not on a team.",
        },
      ],
    };
  }
  if (name === "send_message") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    if (bot.awaitingUserSelection) return { content: [{ type: "text", text: AWAITING_BLOCKED }], isError: true };
    const card = cardFromSendMessageArgs(bot, args);
    if (card) {
      await store.patchBot(botId, (b) => {
        b.messages = b.messages || [];
        if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card as StoredCard);
        b.awaitingUserSelection = true;
      });
      await emit("message", card);
      // See agent.mts: the lead's question shows in the team channel, same id.
      if (bot.teamId && bot.teamRole === "chief") {
        const posted = await teams.appendMessage(bot.teamId, { ...(card as unknown as Record<string, unknown>), speakerId: bot.id, speakerName: bot.name, speakerRole: "chief" });
        await emit("team-message", { teamId: bot.teamId, ...posted });
      }
      await endTurnKeepBot();
      return { content: [{ type: "text", text: "asked the user; wait for their pick in chat" }] };
    }
    // server/agent.mts (the same tool in the other harness) redacts here; this
    // path did not, so a secret reaching model-authored content was written
    // verbatim into the chat, the stored message list and team history.
    const content = vault.redactSecrets(String(args.content || "").trim(), await vault.listSecrets());
    if (!content) return { content: [{ type: "text", text: "empty" }], isError: true };
    const out = {
      id: `a${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      speakerRole: bot.teamRole || "",
      content,
      ts: Date.now(),
    };
    await emit("message", out);
    if (bot.teamId) {
      const posted = await teams.appendMessage(bot.teamId, { ...out, teamId: bot.teamId });
      await emit("team-message", { teamId: bot.teamId, ...posted });
      const team = await teams.getTeam(bot.teamId);
      if (bot.teamRole === "chief") {
        const { job, finalized } = teams.maybeFinalizeSummary(team?.job);
        if (finalized) {
          await teams.saveTeam({ ...team, job });
          await emit("job", { teamId: bot.teamId, job });
        }
      }
      // Everyone sees the message in the shared log; only the teammates the
      // sender addressed are woken — named in `to`, or @mentioned in the text —
      // via the server's team-dispatch.
      const allBots = await store.loadBots();
      const roster = teams.membersOf(team, allBots).map((b) => {
        const bb = b as { id: string; name?: string; teamRole?: string; channelState?: "active" | "hold" };
        return { id: bb.id, name: bb.name, teamRole: bb.teamRole, channelState: bb.channelState };
      });
      const to = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
      const { wake } = teams.routeChannelMessage({ authorId: bot.id, text: content, members: roster, to });
      if (wake.length && emitUrl && token) {
        for (const id of wake) {
          try {
            await fetch(`${emitUrl}/api/internal/team-dispatch`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-sub8-token": token },
              body: JSON.stringify({ fromId: bot.id, toId: id, content }),
            });
          } catch {
            /* dispatch is best-effort */
          }
        }
      }
    }
    return { content: [{ type: "text", text: "sent" }] };
  }
  if (name === "nothing_to_add") {
    // Ends the turn now, so the harness never produces a closing remark. Same
    // mechanism as a widget ending the turn, minus the wait-for-a-pick state.
    if (emitUrl && token && botId) {
      try {
        await fetch(`${emitUrl}/api/internal/quiet-end`, { method: "POST", headers: { "Content-Type": "application/json", "x-sub8-token": token }, body: JSON.stringify({ botId }) });
      } catch {
        /* best-effort */
      }
    }
    return { content: [{ type: "text", text: "ending quietly" }] };
  }
  if (name === "message_teammate") {
    // Done by the server (see index.mts teammateMessage): the subprocess no
    // longer touches the store for this — one call, no cross-process locks.
    const to = String(args.bot_id || "");
    const rawBody = [args.content, args.message, args.text, args.detail].map((v) => String(v || "").trim()).find(Boolean) || "";
    // Redacted here before the hop AND again server-side: a vault secret must
    // never leave this process in the clear, whoever ends up storing it.
    const content = vault.redactSecrets(sendToAgentContent(rawBody), await vault.listSecrets());
    if (!content) return { content: [{ type: "text", text: "empty message — pass the note in `content`" }], isError: true };
    if (!emitUrl || !token || !botId) return { content: [{ type: "text", text: "team tools unavailable in this session" }], isError: true };
    try {
      const res = await fetch(`${emitUrl}/api/internal/team-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sub8-token": token },
        body: JSON.stringify({ fromId: botId, to, content, label: args.label, status: args.status, detail: args.detail, stepId: args.step_id }),
      });
      const r = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; isError?: boolean; error?: string };
      if (!res.ok) return { content: [{ type: "text", text: r.error || `server ${res.status}` }], isError: true };
      return { content: [{ type: "text", text: r.text || (r.ok ? "sent" : "failed") }], ...(r.isError ? { isError: true } : {}) };
    } catch (err) {
      return { content: [{ type: "text", text: `could not reach the server: ${(err as Error).message}` }], isError: true };
    }
  }
  if (name === "list_tasks") {
    const bot = await store.getBot(botId);
    if (!bot?.teamId) return { content: [{ type: "text", text: "You are not on a team." }], isError: true };
    const team = await teams.getTeam(bot.teamId);
    if (!team?.job) return { content: [{ type: "text", text: "No team job yet." }] };
    return {
      content: [{ type: "text", text: JSON.stringify({ title: team.job.title, ...teams.jobProgress(team.job), steps: team.job.steps }, null, 2) }],
    };
  }
  if (name === "set_job") {
    const bot = await store.getBot(botId);
    if (!bot?.teamId) return { content: [{ type: "text", text: "You are not on a team." }], isError: true };
    const saved = await teams.setTeamJob(bot.teamId, { title: args.title, steps: args.steps });
    if (saved?.job) await emit("job", { teamId: bot.teamId, job: saved.job });
    for (const b of saved?.renamed || []) {
      await emit("teammate", {
        bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
      });
    }
    return { content: [{ type: "text", text: saved?.job ? `Job “${saved.job.title}”` : "could not set job" }] };
  }
  if (name === "update_task") {
    const bot = await store.getBot(botId);
    if (!bot?.teamId) return { content: [{ type: "text", text: "You are not on a team." }], isError: true };
    const bumped = await teams.patchTeamStep(bot.teamId, {
      stepId: args.step_id,
      label: args.label,
      botId: bot.id,
      status: args.status,
      detail: args.detail,
    });
    if (!bumped?.step) return { content: [{ type: "text", text: "no matching step" }], isError: true };
    await emit("job", { teamId: bot.teamId, job: bumped.job });
    for (const b of bumped.renamed || []) {
      await emit("teammate", {
        bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
      });
    }
    return { content: [{ type: "text", text: `${bumped.step.label}: ${bumped.step.status}` }] };
  }
  if (name === "ask_user") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    // Non-null: `type: "widget"` is the arm of cardFromSendMessageArgs that always
    // builds a card.
    const askChoices = Array.isArray(args.choices) && args.choices.length ? args.choices : [];
    // No options given = a free-text question — see agent.mts.
    const card = cardFromSendMessageArgs(bot, {
      type: "widget",
      question: args.question,
      hint: args.hint,
      choices: askChoices.length ? askChoices : [{ id: "answer", label: "Type your answer below" }],
      allow_custom: askChoices.length ? args.allow_custom : true,
    })!;
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card as StoredCard);
      b.awaitingUserSelection = true;
    });
    await emit("message", card);
    await endTurnKeepBot();
    return { content: [{ type: "text", text: "asked the user; wait for their pick in chat" }] };
  }
  if (name === "create_teammate") {
    const bot = await store.getBot(botId) as McpBot | null;
    if (!bot) throw new Error("Bot not found");
    // Same rule as agent.mts: no card, a default job, straight to work.
    const job = String(args.job || "").trim() || "General helper on this computer. Takes tasks from the lead.";
    const nm = String(args.name || "").trim() || "Worker";
    const team = await teams.ensureTeamForBot(bot);
    const { bot: mate } = await teams.addMember(team, {
      name: nm,
      job,
      role: args.role === "chief" ? "chief" : "worker",
      harness: {
        ...(bot.harness || {}),
        ...(args.harness || args.provider ? { provider: String(args.harness || args.provider) } : {}),
        ...(args.model
          ? { model: String(args.model) }
          : String(args.harness || args.provider) === "cursor"
            ? { model: "cursor-grok-4.6-low" }
            : {}),
      },
      color: args.color != null ? String(args.color) : undefined,
      instructions: args.instructions != null ? String(args.instructions) : job,
    });
    const note = {
      id: `a${Date.now()}nb`,
      role: "assistant",
      speakerId: bot.id,
      speakerName: bot.name,
      content: `Created ${mate.name} on this desk to ${job}. They’re in the sidebar on this team.`,
      ts: Date.now(),
    };
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      b.messages.push(note);
      b.teamId = team.id;
      b.teamRole = b.teamRole || "chief";
    });
    await emit("message", note);
    await emit("teammate", { bot: { id: mate.id, name: mate.name, teamId: mate.teamId, teamRole: mate.teamRole, color: mate.color, harness: mate.harness, vm: mate.vm } });
    if (mate.teamRole !== "chief") {
      const assigned = await teams.onWorkerAssigned(team.id, mate.id, {
        label: mate.name,
        content: job,
        status: "pending",
      });
      if (assigned?.team?.job) await emit("job", { teamId: team.id, job: assigned.team.job });
      for (const b of assigned?.renamed || []) {
        await emit("teammate", {
          bot: { id: b.id, name: b.name, teamId: b.teamId, teamRole: b.teamRole, color: b.color, harness: b.harness, vm: b.vm, description: b.description },
        });
      }
    }
    return { content: [{ type: "text", text: `created ${mate.name} (${mate.id})` }] };
  }
  if (name === "rename_bot" || name === "update_bot") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const targetId = String(args.bot_id || bot.id);
    const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
    const target = await store.getBot(targetId) as McpBot | null;
    if (!target) return { content: [{ type: "text", text: "bot not found" }], isError: true };
    if (target.id !== bot.id && (!team || !team.memberIds?.includes(target.id))) {
      return { content: [{ type: "text", text: "that Bot is not on your team" }], isError: true };
    }
    const patched = await teams.applyBotPatch(target, args, { tool: name });
    // Non-null: `applyBotPatch` only reports `ok: false` with a reason attached.
    if (!patched.ok) return { content: [{ type: "text", text: patched.refused! }], isError: true };
    await emit("teammate", { bot: { id: target.id, name: target.name, teamId: target.teamId, teamRole: target.teamRole, color: target.color, harness: target.harness, vm: target.vm } });
    const notes = [];
    if (patched.ignored.length) notes.push(`rename_bot only sets the name; ignored ${patched.ignored.join(", ")} (use update_bot for those)`);
    // Non-null: `prior` is only set on the same return that fills `changed`.
    if (patched.prior) notes.push(`previous ${patched.changed!.join("/")} kept on the record as priorIdentity: ${JSON.stringify(patched.prior)}`);
    return { content: [{ type: "text", text: `updated ${target.name}${notes.length ? `. ${notes.join(". ")}` : ""}` }] };
  }
  if (name === "hold_teammate" || name === "resume_teammate") {
    const toId = String(args.bot_id || "");
    if (!toId) return { content: [{ type: "text", text: "bot_id required" }], isError: true };
    const target = await store.getBot(toId);
    if (!target) return { content: [{ type: "text", text: "bot not found" }], isError: true };
    const state = name === "hold_teammate" ? "hold" : "active";
    await teams.setChannelState(toId, state);
    await emit("teammate", { bot: { id: target.id, name: target.name, teamId: target.teamId, teamRole: target.teamRole, channelState: state } });
    return { content: [{ type: "text", text: `${target.name} is ${state === "hold" ? "on hold" : "active"}` }] };
  }
  if (name === "delete_teammate") {
    const bot = await store.getBot(botId);
    if (!bot) throw new Error("Bot not found");
    const team = bot.teamId ? await teams.getTeam(bot.teamId) : null;
    const { ids, error } = await teams.closeTargetsForBot(bot, args);
    if (error) return { content: [{ type: "text", text: error }], isError: true };
    // Non-null: `closeTargetsForBot` answers either an `error` — returned just above — or
    // a list, never neither.
    if (!ids!.length) return { content: [{ type: "text", text: "no workers to close" }] };
    const labels = [];
    for (const targetId of ids!) {
      const target = await store.getBot(targetId);
      labels.push(target?.name || targetId);
      if (emitUrl && token) {
        try {
          await fetch(`${emitUrl}/api/internal/team-dispatch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-sub8-token": token },
            body: JSON.stringify({ stopId: targetId }),
          });
        } catch {
          /* ignore */
        }
      }
      {
        // Free the teammate's X display + Chrome on the shared desk (see index.mts DELETE /api/bots/:id).
        const gone = await store.getBot(targetId).catch(() => null);
        const disp = gone ? vm.displayNum(gone as unknown as vm.Bot) : 0;
        const box = String((gone as { vm?: { container?: unknown } } | null)?.vm?.container || "");
        if (box && disp > 1) await vm.stopDisplay(box, disp).catch(() => {});
      }
      await store.deleteBot(targetId);
      await emit("teammate", { gone: targetId });
    }
    if (team) await teams.removeMembers(team, ids);
    await teams.pruneSoloTeams();
    return { content: [{ type: "text", text: `deleted ${labels.join(", ")}` }] };
  }
  if (name === "web_search") {
    const settings = await store.loadSettings();
    const q = String(args.query || "").trim();
    if (!q) return { content: [{ type: "text", text: "empty query" }] };
    const h = settings?.harness || {};
    const key = (h.apiKey && h.apiKey.trim()) || process.env[h.apiKeyEnv || "XAI_API_KEY"] || process.env.XAI_API_KEY;
    if (!key) return { content: [{ type: "text", text: "No API key for web_search." }] };
    const base = (h.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: h.model || "grok-4.6",
          input: [{ role: "user", content: q }],
          tools: [{ type: "web_search" }],
          reasoning: { effort: "low" },
        }),
        signal: AbortSignal.timeout(70_000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { content: [{ type: "text", text: `web_search failed (${res.status})` }] };
      const text = JSON.stringify(json).slice(0, 4000);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `web_search failed: ${(err as Error).message}` }] };
    }
  }
  if (name === "web_fetch") {
    const r = await webFetch(args.url);
    return { content: [{ type: "text", text: r.text || "" }] };
  }
  if (name === "read") {
    // `getBot` can answer null and `readFile` is fine with that — `resolveReadPath`
    // only ever optional-chains the row — but `ReadFileBot` is spelled without the
    // `null`. The assertion keeps the shorthand property and emits nothing.
    const bot = await store.getBot(botId) as McpBot;
    const r = await readFile({ path: args.path, bot });
    // Non-null: `readFile` fills `text` on every `kind: "text"` result.
    // Redacted for the same reason as `memory` above -- resolveReadPath
    // resolves /config/.desk-token quite happily.
    const raw = r.kind === "text" ? r.text! : `${r.kind}: ${r.path}`;
    return { content: [{ type: "text", text: vault.redactSecrets(raw, await vault.listSecrets()) }] };
  }
  if (name === "create_channel") {
    const bot = await store.getBot(botId);
    const row = await channels.createChannel({
      name: args.name,
      memberIds: args.member_ids || [bot?.id].filter(Boolean),
      description: args.description,
    });
    // See the note in agent.mts: the tool advertises "Writes group.json" but
    // only the HTTP routes ever wrote it.
    syncChannelDesk(row);
    return { content: [{ type: "text", text: JSON.stringify(row) }] };
  }
  if (name === "update_channel") {
    const id = args.channel_id;
    if (args.add_id) {
      const row = await channels.addMember(id, args.add_id);
      syncChannelDesk(row);
      return { content: [{ type: "text", text: JSON.stringify(row) }] };
    }
    if (args.remove_id) {
      const row = await channels.removeMember(id, args.remove_id);
      syncChannelDesk(row);
      return { content: [{ type: "text", text: JSON.stringify(row) }] };
    }
    return { content: [{ type: "text", text: "pass add_id or remove_id" }], isError: true };
  }
  if (name === "task") {
    const self = await store.getBot(botId) as McpBot | null;
    const row = await subagents.spawn({
      botId,
      type: args.type || "executor",
      prompt: args.prompt,
      display: self?.vm?.display,
      computerId: self?.vm?.computerId,
      container: self?.vm?.container,
      harnessUrl: self?.vm?.harnessPort ? `http://127.0.0.1:${self.vm.harnessPort}` : self?.vm?.hostHarnessPort ? `http://127.0.0.1:${self.vm.hostHarnessPort}` : null,
      harnessToken: token,
    });
    return { content: [{ type: "text", text: JSON.stringify(row) }] };
  }
  if (name === "check_subagent") {
    if (args.id) {
      const row = await subagents.get(args.id, botId);
      return { content: [{ type: "text", text: row ? JSON.stringify(row) : "not found" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(await subagents.list(botId)) }] };
  }
  if (name === "message_subagent") {
    // Non-null: `id` and `message` are `required` in this tool's inputSchema.
    return { content: [{ type: "text", text: JSON.stringify(await subagents.message(args.id!, args.message, botId)) }] };
  }
  if (name === "stop_subagent") {
    // Non-null: `id` is `required` in this tool's inputSchema.
    return { content: [{ type: "text", text: JSON.stringify(await subagents.stop(args.id!, botId)) }] };
  }
  if (name === "await_shell") {
    const bot = await store.getBot(botId) as McpBot | null;
    const job = (await bgShell.awaitShell(args.id, bot?.id || botId)) || (bot?.backgroundShells || []).find((j) => !args.id || j.id === args.id);
    if (job && bot) {
      bgShell.attachToBot(bot, job);
      await store.upsertBot(bot);
    }
    return { content: [{ type: "text", text: job ? JSON.stringify(job) : "no background shell" }] };
  }
  if (name === "add_mcp_server") {
    const row = await mcpRemote.addServer({ name: args.name, url: args.url, headers: args.headers });
    return { content: [{ type: "text", text: JSON.stringify(row) }] };
  }
  if (name === "get_mcp_tools") {
    // Non-null: `server_id` is `required` in this tool's inputSchema.
    const out = await mcpRemote.getMcpTools(args.server_id!);
    if (out.needsAuth) return { content: [{ type: "text", text: "needsAuth — call authenticate_mcp_server" }] };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }
  if (name === "call_mcp_tool") {
    // Non-null: `server_id` is `required` in this tool's inputSchema.
    const out = await mcpRemote.callMcpTool(args.server_id!, args.tool, args.arguments || args.args);
    if (out.needsAuth) return { content: [{ type: "text", text: "needsAuth — call authenticate_mcp_server" }] };
    return { content: [{ type: "text", text: JSON.stringify(out.result ?? out) }] };
  }
  if (name === "authenticate_mcp_server") {
    const bot = await store.getBot(botId) as McpBot | null;
    // Non-null: `server_id` is `required` in this tool's inputSchema.
    const row = await mcpRemote.getServer(args.server_id!);
    if (!row || !bot) return { content: [{ type: "text", text: "server not found" }], isError: true };
    // Non-null: `connectCard` is a `type: "secret-request"` payload, the arm of
    // cardFromSendMessageArgs that always builds a card.
    const card = cardFromSendMessageArgs(bot, mcpRemote.connectCard(bot, row))!;
    await store.patchBot(botId, (b) => {
      b.messages = b.messages || [];
      if (!b.messages.some((m) => m.id === card.id)) b.messages.push(card as StoredCard);
      b.awaitingUserSelection = true;
    });
    await emit("message", card);
    await endTurnKeepBot();
    return { content: [{ type: "text", text: "asked the user to connect; wait for the masked field" }] };
  }
  throw new Error(`unknown tool ${name}`);
}

function result(id: unknown, payload: unknown): void {
  send({ jsonrpc: "2.0", id, result: payload });
}

function fail(id: unknown, message: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message || "error") } });
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sub8", version: "0.3.10" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/call") {
    try {
      const out = await callTool(params?.name, params?.arguments || {});
      result(id, out);
    } catch (err) {
      result(id, { content: [{ type: "text", text: (err as Error).message }], isError: true });
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  }
}

if (isMain()) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      handle(msg).catch((err: unknown) => {
        if (msg.id !== undefined) fail(msg.id, (err as Error).message);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
