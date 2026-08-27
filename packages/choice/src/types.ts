/** One button on an ask_user card. */
export interface ChoiceOption {
  id: string;
  label: string;
}

/** What the model may hand `choiceCard` as an option: `{id|value, label|value}`. */
export interface ChoiceInput {
  id?: unknown;
  value?: unknown;
  label?: unknown;
}

/** Where a typed credential goes. Never into the transcript. */
export interface SecretTarget {
  connector: string;
  field: string;
}

/** The pick the human made, once the card is closed. */
export interface SelectedChoice {
  id?: string;
  label?: string;
}

/** The Bot the card is attributed to. */
export interface ChoiceSpeaker {
  id?: string;
  name?: string;
}

/** The card `choiceCard` builds and the UI renders. */
export interface ChoiceCard {
  id: string;
  role: "assistant";
  kind: "choices" | "secret-request";
  content: string;
  hint: string;
  choices: ChoiceOption[];
  allowCustom: boolean;
  dismissOnMoveOn: boolean;
  pending: boolean;
  /** Only ever `true` or absent — a `false` here would render a secret field. */
  secret?: boolean | undefined;
  speakerId?: string | undefined;
  speakerName?: string | undefined;
  ts: number;
  secretTarget?: SecretTarget;
  selected?: SelectedChoice | null;
}

/** The subset of a stored chat row the choice rules read. */
export interface ChoiceRow {
  id?: unknown;
  kind?: string;
  role?: string;
  content?: string;
  choices?: ChoiceOption[];
  pending?: boolean;
  secret?: boolean | undefined;
  selected?: SelectedChoice | null;
  secretTarget?: SecretTarget;
}

export interface ChoiceCardArgs {
  bot?: ChoiceSpeaker | null | undefined;
  question?: unknown;
  hint?: unknown;
  choices?: unknown;
  allowCustom?: unknown;
  secret?: boolean;
  dismissOnMoveOn?: unknown;
}

/** The `widget` block of a send_message tool call. */
export interface WidgetSpec {
  prompt?: string;
  options?: unknown;
  helpText?: string;
  allowCustom?: boolean;
  dismissOnMoveOn?: boolean;
}

/** The `secret` block of a send_message tool call. */
export interface SecretSpec {
  label?: string;
  description?: string;
  connector?: string;
  field?: string;
}

/** send_message's arguments, as the harness hands them over. */
export interface SendMessageArgs {
  type?: unknown;
  widget?: unknown;
  question?: unknown;
  content?: unknown;
  choices?: unknown;
  hint?: unknown;
  allow_custom?: unknown;
  secret?: unknown;
}

/** Whatever the bot record is, these are the two fields this module touches. */
export interface ChoiceBot {
  messages?: ChoiceRow[];
  awaitingUserSelection?: boolean;
}

export interface ResolveChoiceArgs {
  messageId?: string;
  choiceId?: string;
  custom?: string;
}

/** What POST /choice does next. */
export interface ChoiceResolution {
  ok: boolean;
  /** The card was already closed on this same pick — a double-Enter, not an error. */
  already?: boolean;
  /** SSE showed the card before disk caught up; send the answer anyway. */
  missing?: boolean;
  card?: ChoiceRow | null;
  label?: string;
  choiceId?: string;
  error?: string;
}

/** What the transcript and the next turn see. Never the typed secret. */
export interface ChoiceReply {
  secret: boolean;
  selectedLabel: string;
  userContent: string;
  nextTurn: string;
}
