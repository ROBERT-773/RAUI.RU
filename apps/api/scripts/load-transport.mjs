import { Agent, request } from 'node:http';
import { Readable } from 'node:stream';
import { localLoadTarget } from './load.mjs';

// Four actual peers, matching concurrency four. Do not spoof forwarding headers,
// erase rate-limit facts or weaken the application's per-client auth quota.
export function createLoopbackLoadClients() {
  const agents = Array.from(
    { length: 4 },
    (_, index) =>
      new Agent({
        keepAlive: true,
        maxSockets: 1,
        localAddress: `127.0.0.${index + 2}`,
      }),
  );
  let next = 0;
  return {
    async fetch(value, options) {
      const url = localLoadTarget(value);
      const slot = options.loadClient ?? next++ % agents.length;
      if (!Number.isInteger(slot) || slot < 0 || slot >= agents.length)
        throw new Error('Invalid local load client slot');
      const agent = agents[slot];
      return new Promise((resolve, reject) => {
        const outgoing = request(
          url,
          {
            agent,
            method: options.method,
            headers: options.headers,
            signal: options.signal,
            maxHeaderSize: 16384,
          },
          (incoming) => {
            if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
              incoming.resume();
              reject(new Error('Load redirect rejected'));
              return;
            }
            try {
              const noBody = [204, 205].includes(incoming.statusCode);
              if (noBody) incoming.resume();
              resolve(
                new Response(noBody ? null : Readable.toWeb(incoming), {
                  status: incoming.statusCode,
                  headers: Object.entries(incoming.headers).flatMap(
                    ([name, value]) =>
                      value === undefined
                        ? []
                        : [
                            [
                              name,
                              Array.isArray(value) ? value.join(', ') : value,
                            ],
                          ],
                  ),
                }),
              );
            } catch {
              incoming.destroy();
              reject(new Error('Local load response failed'));
            }
          },
        );
        outgoing.once('error', () =>
          reject(new Error('Local load transport failed')),
        );
        outgoing.end(options.body);
      });
    },
    close() {
      for (const agent of agents) agent.destroy();
    },
  };
}
