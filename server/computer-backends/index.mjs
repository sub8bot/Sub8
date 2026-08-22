import { computerBackendName } from "../computers.mjs";
import { localDockerBackend } from "./local-docker.mjs";

const backends = new Map([[localDockerBackend.name, localDockerBackend]]);

export function resolveComputerBackend(computer) {
  const name = computerBackendName(computer);
  const backend = backends.get(name);
  if (!backend) throw new Error(`Unknown computer backend: ${String(name)}`);
  return backend;
}
