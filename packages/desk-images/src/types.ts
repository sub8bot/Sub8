/** Injected docker runner. The package never spawns docker itself. */
export type DockerRun = (
  argv: string[],
) => Promise<{ ok: boolean; out: string; err: string }>;
