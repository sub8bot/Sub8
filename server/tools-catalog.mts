import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * One JSON-Schema node inside a tool's `parameters`. Open on purpose: this is
 * the subset of JSON Schema the catalog actually spells, and it is what the
 * harnesses are handed verbatim.
 */
export interface ToolParameterSchema {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
}

/** One entry of TOOLS, in the OpenAI function-tool shape the harnesses take. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

// Electron asar omits packages/; use dist when the repo tree is present.
const distTools = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/orchestration/dist/tools.js");
/** Must equal @sub8/orchestration TOOL_ALIASES (used when packages/ is omitted from asar). */
export const FALLBACK_ALIASES = {
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
const { TOOL_ALIASES }: { TOOL_ALIASES: Record<string, string> } = existsSync(distTools)
  ? await import(pathToFileURL(distTools).href)
  : { TOOL_ALIASES: FALLBACK_ALIASES };

export function canonicalToolName(name: unknown): string {
  const raw = String(name ?? "");
  return TOOL_ALIASES[raw] || raw;
}

export const COMPUTER_ACTIONS: string[] = [
  "screenshot",
  "mouse_move",
  "left_click",
  "right_click",
  "double_click",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "wait",
  "clipboard_read",
  "clipboard_write",
  "open",
];

export const BROWSER_ACTIONS: string[] = ["snapshot", "click", "fill", "select", "navigate", "press", "wait"];

export const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "send_message",
      description:
        "User-visible chat — your only voice. The user never sees plain assistant text. On a user turn, ack first with send_message before other tools (in a team, the lead's delegation line is the ack). Ack ≠ delivery: the last send_message is the result. type=widget asks a question (1–6 options) and ENDS the turn; their pick is the next message. type=secret-request asks for a credential via a masked field (never chat paste) and ENDS the turn. In a team the whole team sees it too; pass `to` (names or ids) to wake specific teammates. A worker's answer to the lead is its final message, not a send_message.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "widget", "secret-request", "attachment"], description: "Default text." },
          content: { type: "string", description: "Required for type=text." },
          to: { type: "array", items: { type: "string" }, description: "Teammates to wake with this message (names or ids). Omit for the user only." },
          question: { type: "string", description: "Widget prompt (or use widget.prompt)." },
          hint: { type: "string" },
          choices: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, value: { type: "string" } } },
          },
          allow_custom: { type: "boolean" },
          widget: { type: "object", description: "{ prompt, helpText, options, allowCustom, dismissOnMoveOn }" },
          secret: {
            type: "object",
            properties: { label: { type: "string" }, description: { type: "string" }, connector: { type: "string" }, field: { type: "string" } },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file on your computer (path under /config). Text includes contents. Images/PDFs return a stub. Not the user's Mac. Alias: Read.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a public http(s) URL as markdown. No localhost or private IPs. Alias: WebFetch.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "await_shell",
      description: "Wait on a background shell started with shell block_until_ms=0. Alias: AwaitShell.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "create_channel",
      description: "Create a chat room (not a desk). Max 6 members. Writes group.json. Alias: CreateChannel.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          member_ids: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_channel",
      description: "Add or remove a room member. Cannot empty the room. Alias: UpdateChannel.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          add_id: { type: "string" },
          remove_id: { type: "string" },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description: "Spawn a background worker on this desk. Types: executor, browserUse, computerUse. Workers cannot send_message. Alias: Task.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["executor", "browserUse", "computerUse", "watchVideo", "videoReview"] },
          prompt: { type: "string" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_subagent",
      description: "Status of a Task worker (pass id) or list yours. Alias: CheckSubagent.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "message_subagent",
      description: "Leave a note on a Task. NOT delivered to a running worker -- to change course, stop_subagent and spawn a new task. Alias: MessageSubagent.",
      parameters: { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_subagent",
      description: "Abort a Task. Does not destroy the desk. Alias: StopSubagent.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "cloud_agent",
      description:
        "Coding session on THIS desk (same /config). launch/list/get/reply/cancel/delete. Not a second computer. Alias: CloudAgent.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["launch", "list", "get", "reply", "cancel", "delete"] },
          prompt: { type: "string" },
          repoUrl: { type: "string" },
          cwd: { type: "string" },
          id: { type: "string" },
          message: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer",
      description:
        "Pixel desktop. Use browser (snapshot/click ref/fill/navigate) for web pages first. This tool is for screenshots, native dialogs, drag, and clicks the page agent cannot do. x,y are pixels on the LAST screenshot (origin top-left, 1:1 with the full 1024x768 image). type pastes exact text (URLs keep ://). key is Return/ctrl+l — never send a URL via key.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: COMPUTER_ACTIONS },
          x: { type: "number" },
          y: { type: "number" },
          x2: { type: "number", description: "Drag end x" },
          y2: { type: "number", description: "Drag end y" },
          text: { type: "string", description: "Typed text, or a URL for action=open" },
          keys: { type: "string" },
          dy: { type: "number" },
          dx: { type: "number" },
          ms: { type: "number" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser",
      description:
        "Drive YOUR Chrome tab by page structure (not pixels). snapshot returns [n] refs. click/fill those refs. select picks a dropdown option by visible text (ref + text). navigate replaces the tab. Prefer this over computer clicks on websites. File dialogs, drag, and native apps still use computer.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: BROWSER_ACTIONS },
          ref: { type: "number", description: "Node number from the last snapshot" },
          text: { type: "string", description: "Fill text, or a URL for navigate" },
          url: { type: "string" },
          keys: { type: "string", description: "For press: Enter, Tab, Escape" },
          ms: { type: "number" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run a command on your computer (home /config). Files, apt, desk-doctor. Not the user's Mac. Do not click, type, or drive Chrome from the shell. block_until_ms=0 backgrounds the job; poll with await_shell. Alias: Shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          block_until_ms: { type: "number", description: "0 = background and return an id. Default waits for exit." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description:
        "Read or write lasting notes on my computer (markdown under /config/agent-data and /config/workspace). Not HTTP. Use this for durable facts and repeating-job history.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write", "append", "list"] },
          path: { type: "string", description: "Absolute under /config/agent-data or /config/workspace, or relative to this Bot's agent folder." },
          content: { type: "string", description: "For write or append." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_state",
      description:
        "Change this Bot's lasting state: memory, routines, skills, profile, or projects. Prefer this over hand-editing files. target + action. avatar, settings, and channel are not wired yet.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["memory", "routine", "skill", "profile", "settings", "project", "avatar", "channel"],
          },
          action: { type: "string", description: "memory: write|forget. routine: create|update|pause|resume|delete. skill: write|delete. profile: set. project: create|join|leave." },
          scope: { type: "string", enum: ["agent", "user", "project"], description: "memory scope; agent is default" },
          tier: { type: "string", enum: ["profile", "log", "note"], description: "memory tier; note is default" },
          slug: { type: "string", description: "project slug" },
          path: { type: "string", description: "memory path under /config/agent-data or /config/workspace" },
          content: { type: "string" },
          id: { type: "string", description: "routine or skill id" },
          name: { type: "string" },
          description: { type: "string" },
          instruction: { type: "string", description: "routine standing brief" },
          prompt: { type: "string", description: "routine standing brief (alias of instruction)" },
          schedule: { description: "Routine cadence: cron string or {type, hour, minute}" },
          interval_minutes: { type: "number" },
        once_at: { type: "string", description: "ISO-8601 time for a ONE-OFF reminder ('remind me in 2 minutes' → now + 2 min). Creates a separate job that fires once; never claim a reminder is set without this." },
          body: { type: "string", description: "skill markdown body" },
          confirm: { type: "boolean", description: "required true to delete a skill" },
        },
        required: ["target", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_routine",
      description:
        "Create or UPDATE a standing routine only when the user asked to keep doing a job on a clock (every N minutes, hourly, daily, or every morning). instruction must be a standing brief (what to watch, cadence, next checkpoint), never 'check again' or the raw chat line. Default: update the existing routine (pass id from list_routines). Only set force_new true if they asked for a second job.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing routine id to update" },
          name: { type: "string" },
          instruction: { type: "string" },
          interval_minutes: { type: "number", description: "Elapsed minutes. Omit for every-morning wall-clock jobs." },
          schedule: {
            type: "object",
            description: "Wall-clock job. For every morning use {type:\"daily\", hour:9, minute:0}. Do not also send interval_minutes.",
            properties: {
              type: { type: "string" },
              hour: { type: "number" },
              minute: { type: "number" },
            },
          },
          group_key: { type: "string", description: "general unless user asked for a separate job" },
          force_new: { type: "boolean" },
          force_replace: { type: "boolean", description: "true when the operator asked to rewrite the standing brief" },
          solo: { type: "boolean", description: "default true: drop other routines so only this one remains" },
          replace: { type: "boolean", description: "default true: replace instruction instead of appending" },
          enabled: { type: "boolean" },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_routines",
      description: "List standing routines.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "disable_routine",
      description: "Turn off a routine by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_teammates",
      description: "List the other Bots on your team (id, name, role). Empty if you are not on a team.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "nothing_to_add",
      description: "A teammate's report needs no reply from you — the user already sees it in the channel. Call this to end your turn quietly. Do not write a closing remark instead.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "message_teammate",
      description:
        "SendToAgent: fire-and-forget a note to a bot UUID or a room UUID. Pass bot_id from list_teammates, create_teammate, or create_channel. Never invent a UUID. Team job-bar fields (label/status/detail) still apply when you are on a desk crew. Do not pass status=running on a step that is already done — that is a follow-up note, not a restart.",
      parameters: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "Teammate id from list_teammates" },
          content: { type: "string", description: "One short line. Long notes stay in your own chat." },
          label: { type: "string", description: "Job-step label. Chief: this becomes the worker's tab name." },
          status: { type: "string", enum: ["pending", "running", "done", "blocked", "looping"] },
          detail: { type: "string", description: "Short progress line for the job bar (max ~160 chars)" },
        },
        required: ["bot_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "Show the current team job and each step (pending/running/done/blocked/looping).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "set_job",
      description: "Chief: replace the team job on the progress bar. steps: [{label, bot_id}]. Worker tab names follow those labels. One-shot work uses this, not upsert_routine.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                bot_id: { type: "string" },
                status: { type: "string" },
                detail: { type: "string" },
              },
            },
          },
        },
        required: ["title", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Set your step on the team progress bar: pending, running, done, blocked, or looping. detail is a short result (e.g. place and rating). Call running when you start, done when finished. If you are stuck repeating, status=looping.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Alias of send_message type=widget. Shows a multiple-choice card and ENDS the turn. Prefer send_message widget. Do not keep a second question system.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          hint: { type: "string" },
          choices: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
            },
          },
          allow_custom: { type: "boolean" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_teammate",
      description:
        "Create another Bot in your group on the same shared desk. Pass name and job — take the job from the user's words ('ask it to say hello' → the job includes that); a missing job defaults to general helper, so never ask the user what the teammate is for. You MAY set harness (claude, grok-build, hermes, codex, cursor, ollama, lmstudio), model, instructions, color.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          job: { type: "string", description: "What this Bot should do" },
          role: { type: "string", description: "worker (default) or chief" },
          harness: { type: "string" },
          model: { type: "string" },
          instructions: { type: "string" },
          color: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_bot",
      description:
        "Change ONLY the display name of yourself or a teammate on this desk. It sets nothing else — their job and description are untouched, and anything else you pass is ignored. This does NOT deliver messages: to say something to a teammate use message_teammate.",
      parameters: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "Defaults to yourself" },
          name: { type: "string", description: "The new short display name, e.g. Scout. Never message text." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_bot",
      description:
        "Change settings for yourself or a teammate: harness, model, instructions, description, color, role. Only for a settings change the user actually asked for. This does NOT deliver messages — message_teammate does that — and never copy message text into name/description/instructions: writing one string into all of them wipes the teammate and is refused.",
      parameters: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "Defaults to yourself" },
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
  },
  {
    type: "function",
    function: {
      name: "delete_teammate",
      description:
        "Close/remove worker bots when the user asks (close all bots, delete teammates, etc). all_workers=true closes every worker except you. Or pass bot_id from list_teammates. Never delete yourself. This is not a job — do not set_job or message_teammate someone to close bots. Their chat is deleted. The shared desk stays.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web via SpaceXAI. Use for news, facts, and flights (e.g. SFO to DCA). Do not open Chrome just to search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_list",
      description:
        "List saved logins this Bot is allowed to use. Returns label, site, username, and id only — never a password.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "vault_fill",
      description:
        "Paste a saved username or password into the focused field on the desktop. Click the field first. Never prints the secret. Use field=username or field=password.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          field: { type: "string", enum: ["username", "password"] },
        },
        required: ["account_id", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_box_help",
      description:
        "Ask the human to press Take control for login, 2FA, captcha, or payment. You never see their password. Does not grant this Mac's filesystem (External* is out). Alias: RequestBoxHelp.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" }, message: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_mcp_server",
      description:
        "Add a remote HTTPS MCP the user named (url + optional headers). Not a marketplace. No Cursor plugins. Alias: AddMcpServer.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          headers: { type: "object" },
        },
        required: ["name", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mcp_tools",
      description: "List tools on a user-added remote MCP server. Alias: GetMcpTools.",
      parameters: { type: "object", properties: { server_id: { type: "string" } }, required: ["server_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "call_mcp_tool",
      description: "Call a tool on a user-added remote MCP. Alias: CallMcpTool.",
      parameters: {
        type: "object",
        properties: {
          server_id: { type: "string" },
          tool: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["server_id", "tool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "authenticate_mcp_server",
      description:
        "Show a masked connect card for a remote MCP and END the turn. Never paste a token in chat. Alias: AuthenticateMcpServer.",
      parameters: { type: "object", properties: { server_id: { type: "string" } }, required: ["server_id"] },
    },
  },
];
