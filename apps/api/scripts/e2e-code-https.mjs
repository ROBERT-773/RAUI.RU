import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';

// SMTP sign-in requires a clean HTTPS origin. Keep both ends on loopback.
export async function openCodeTestOrigin(privateDirectory, webPort = 3100) {
  const key = join(privateDirectory, 'loopback.key');
  const cert = join(privateDirectory, 'loopback.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (incoming, outgoing) => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: webPort,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: 'https://127.0.0.1:' + server.address().port,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
