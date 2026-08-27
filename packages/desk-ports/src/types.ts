import type { Server, Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** `{ containerPort: hostPort }`, as `docker ps` reported it. */
export type PortMap = Record<number, number | undefined>;

/**
 * The far end of the tunnel: either a `docker exec -i` child (stdin/stdout) or
 * a plain socket (pipe). `attachHarnessProxy` handles both without knowing
 * which one it was handed — that is what keeps the docker spawn out of here.
 */
export interface HarnessRemote {
  stdin?: Writable | null | undefined;
  stdout?: Readable | null | undefined;
  kill?: ((signal?: string) => unknown) | undefined;
  destroy?: ((...args: unknown[]) => unknown) | undefined;
  end?: ((...args: unknown[]) => unknown) | undefined;
  on?: ((event: string, listener: (...args: never[]) => void) => unknown) | undefined;
}

/** Called once per accepted connection. Returning nothing hangs up on the client. */
export type ConnectRemote = () =>
  | HarnessRemote
  | null
  | undefined
  | Promise<HarnessRemote | null | undefined>;

export type { Server, Socket };
