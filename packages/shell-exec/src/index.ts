export type {
  ShellBot,
  ShellResult,
  ShellRunner,
  ShellStatus,
  ShellView,
  ShellWake,
  ShellWakeFn,
  StartShellArgs,
  StartedShell,
} from "./types.js";

export {
  attachToBot,
  awaitShell,
  getShell,
  listShells,
  resetForTest,
  setOnCompleteWake,
  startShell,
} from "./background-shell.js";
