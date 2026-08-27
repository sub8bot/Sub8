import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skip as harnessSkip } from "../harness.mjs";

function cloudMockFile() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(os.homedir(), "sub8-cloud", "test", "cloud-mock.mjs"),
    path.join(os.homedir(), "sub8", "cloud", "test", "cloud-mock.mjs"),
    path.resolve(here, "../../../../sub8-cloud/test/cloud-mock.mjs"),
    path.resolve(here, "../../../../cloud/test/cloud-mock.mjs"),
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

/** Cloud Worker e2e mock (no live DigitalOcean). SKIP if private cloud repo is absent. */
export async function run({ skip: skipFn } = {}) {
  const bail = skipFn || harnessSkip;
  const file = cloudMockFile();
  if (!file) bail("sub8-cloud test/cloud-mock.mjs not present");
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.run !== "function") throw new Error("cloud-mock has no run()");
  await mod.run();
}
