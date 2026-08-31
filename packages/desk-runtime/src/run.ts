import { DISPLAY_SLOTS } from "@sub8/desk-ports";
import { HARNESS_PORT } from "@sub8/harness-protocol";
import type { DeskLimits } from "./types.js";

export type LoopbackPublish = {
  kind: "loopback";
  novncPort: number;
  harnessPort: number;
};

export type HostPublish = {
  kind: "host";
  rfbExpose: boolean;
};

export type DeskPublish = LoopbackPublish | HostPublish;

export interface DeskRunSpec {
  name: string;
  volume: string;
  image: string;
  platform: string;
  hostname: string;
  limits: DeskLimits;
  publish: DeskPublish;
  env: readonly string[];
  extraArgs?: readonly string[];
  restart?: string;
}

/** Matches cloud digitalocean dockerPortFlags: host 3001 skipped. */
function hostWebPorts(): string[] {
  return [
    "-p", "3000:3000",
    "-p", "3002:3001",
    "-p", "3003:3002",
    "-p", "3004:3003",
    "-p", "3005:3004",
    "-p", "3006:3005",
    "-p", "3007:3006",
    "-p", "3008:3007",
  ];
}

export function deskRunArgs(spec: DeskRunSpec): string[] {
  const restart = spec.restart || "unless-stopped";
  const args: string[] = [
    "run", "-d",
    "--platform", spec.platform,
    "--name", spec.name,
    "--hostname", spec.hostname,
    "--restart", restart,
    "--shm-size", spec.limits.shm,
    "--memory", spec.limits.memory,
    "--memory-swap", spec.limits.memorySwap,
    "--cpus", spec.limits.cpus,
    "--pids-limit", String(spec.limits.pids),
  ];
  if (spec.extraArgs) args.push(...spec.extraArgs);
  for (const e of spec.env) args.push("-e", e);
  args.push("-v", `${spec.volume}:/config`);
  if (spec.publish.kind === "loopback") {
    const p = spec.publish.novncPort;
    args.push("-p", `127.0.0.1:${p}-${p + DISPLAY_SLOTS - 1}:3000-${3000 + DISPLAY_SLOTS - 1}`);
    args.push("-p", `127.0.0.1:${spec.publish.harnessPort}:${HARNESS_PORT}`);
  } else {
    args.push(...hostWebPorts());
    if (spec.publish.rfbExpose) {
      args.push(
        "-p", "5900:5900",
        "-p", "5901:5901",
        "-p", "5902:5902",
        "-p", "5903:5903",
        "-p", "5904:5904",
        "-p", "5905:5905",
        "-p", "5906:5906",
        "-p", "5907:5907",
      );
    }
  }
  args.push(spec.image);
  return args;
}
