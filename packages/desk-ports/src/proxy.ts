import type { Server, Socket } from "node:net";
import type { Writable } from "node:stream";

import type { ConnectRemote } from "./types.js";

export function attachHarnessProxy<T extends Server>(server: T, connectRemote: ConnectRemote): T {
  server.on("connection", (client: Socket) => {
    Promise.resolve(connectRemote())
      .then((remote) => {
        if (!remote) {
          client.destroy();
          return;
        }
        const hangup = () => {
          try {
            client.destroy();
          } catch {
            /* ignore */
          }
          try {
            remote.kill?.("SIGTERM");
            remote.destroy?.();
            remote.end?.();
          } catch {
            /* ignore */
          }
        };
        if (remote.stdin && remote.stdout) {
          client.pipe(remote.stdin);
          remote.stdout.pipe(client);
        } else {
          client.pipe(remote as unknown as Writable);
          (remote as unknown as Socket).pipe(client);
        }
        client.on("error", hangup);
        remote.on?.("error", hangup);
        client.on("close", hangup);
        remote.on?.("close", hangup);
        remote.on?.("exit", hangup);
      })
      .catch(() => client.destroy());
  });
  return server;
}
