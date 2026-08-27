export type ShellStatus = "running" | "done" | "failed";

/** What a caller sees. The internal row adds the promise and the wake flag. */
export interface ShellView {
  id: string;
  botId: string;
  command: string;
  status: ShellStatus;
  output: string;
  startedAt: number;
  finishedAt: number | null;
}

/** `startShell` marks a job that returned before it finished. */
export interface StartedShell extends ShellView {
  background?: true;
}

/** Whatever the injected runner resolves to. `vm.shell` returns `{ok, output}`. */
export interface ShellResult {
  ok?: boolean;
  output?: string;
  text?: string;
}

/** The desk tunnel, injected — so a test never needs Docker. */
export type ShellRunner = (command: string) => ShellResult | Promise<ShellResult>;

export interface StartShellArgs {
  botId?: unknown;
  command?: unknown;
  /** 0 (or non-finite) returns immediately and wakes on completion instead. */
  blockUntilMs?: unknown;
  run?: ShellRunner;
}

/** The wake a finished background shell asks the host to enqueue. */
export interface ShellWake {
  type: "shell";
  botId: string;
  payload: {
    id: string;
    status: ShellStatus;
    command: string;
  };
}

export type ShellWakeFn = (wake: ShellWake) => void;

/** The one field of the bot record this module touches. */
export interface ShellBot {
  backgroundShells?: ShellView[];
}
