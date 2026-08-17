import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function firstEnv(...keys) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return "";
}

export const appRoot = firstEnv("SUB8BOT_ROOT", "OCTOBOT_ROOT") || path.resolve(here, "..");
export const fileRoot =
  firstEnv("SUB8BOT_FILES", "OCTOBOT_FILES") ||
  (appRoot.endsWith(".asar") ? appRoot.replace(/\.asar$/, ".asar.unpacked") : appRoot);
export const dataDir = firstEnv("SUB8BOT_DATA", "OCTOBOT_DATA") || path.join(process.cwd(), "data");
