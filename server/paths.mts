import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "@sub8/store";

const here = path.dirname(fileURLToPath(import.meta.url));

function firstEnv(...keys: string[]): string {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return "";
}

export const appRoot = firstEnv("SUB8BOT_ROOT", "OCTOBOT_ROOT") || path.resolve(here, "..");
export const fileRoot =
  firstEnv("SUB8BOT_FILES", "OCTOBOT_FILES") ||
  (appRoot.endsWith(".asar") ? appRoot.replace(/\.asar$/, ".asar.unpacked") : appRoot);
/**
 * The data root belongs to @sub8/store, which writes everything under it.
 * Re-exported here so the thirteen `import { dataDir } from "./paths.mjs"`
 * call sites keep working and there is still exactly one definition.
 */
export { dataDir };
