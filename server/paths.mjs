import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const appRoot = process.env.OCTOBOT_ROOT || path.resolve(here, "..");
export const fileRoot =
  process.env.OCTOBOT_FILES ||
  (appRoot.endsWith(".asar") ? appRoot.replace(/\.asar$/, ".asar.unpacked") : appRoot);
export const dataDir = process.env.OCTOBOT_DATA || path.join(process.cwd(), "data");
