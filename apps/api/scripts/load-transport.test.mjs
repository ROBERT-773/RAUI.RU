import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createLoopbackLoadClients } from './load-transport.mjs';
import { readLoadJson } from './load.mjs';

test('Four native load clients have distinct real loopback peer identities without forwarded headers', async () => {
  const peers = [];
  const server = createServer((request, response) => {
    peers.push(request.socket.remoteAddress);
    assert.equal(request.headers['x-forwarded-for'], undefined);
    assert.equal(request.headers['x-raui-client-ip'], undefined);
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = createLoopbackLoadClients();
  try {
    const port = server.address().port;
    await Promise.all(
      Array.from({ length: 4 }, async () =>
        assert.deepEqual(
          await readLoadJson(
            await clients.fetch(`http://127.0.0.1:${port}/v1/categories`, {
              method: 'GET',
              headers: {},
              signal: AbortSignal.timeout(1000),
            }),
          ),
          { ok: true },
        ),
      ),
    );
    assert.deepEqual([...new Set(peers)].sort(), [
      '127.0.0.2',
      '127.0.0.3',
      '127.0.0.4',
      '127.0.0.5',
    ]);
  } finally {
    clients.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('Native load clients reject redirects and abort stalled response bodies', async () => {
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/categories') {
      response.writeHead(307, { Location: '/unexpected' });
      response.end();
    } else if (request.url === '/v1/auth/me') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
    } else {
      redirected++;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = createLoopbackLoadClients();
  try {
    const port = server.address().port;
    await assert.rejects(
      clients.fetch(`http://127.0.0.1:${port}/v1/categories`, {
        method: 'GET',
        headers: {},
        signal: AbortSignal.timeout(1000),
      }),
      /redirect/i,
    );
    assert.equal(redirected, 0);
    await assert.rejects(
      readLoadJson(
        await clients.fetch(`http://127.0.0.1:${port}/v1/auth/me`, {
          method: 'GET',
          headers: {},
          signal: AbortSignal.timeout(30),
        }),
      ),
    );
    await assert.rejects(
      clients.fetch('http://remote.example/v1/categories', {
        method: 'GET',
        headers: {},
      }),
    );
  } finally {
    clients.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Unexpected no-content responses are measured statuses instead of uncaught exceptions', async () => {
  const { boundedOperation } = await import('./e2e-runtime.mjs');
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = createLoopbackLoadClients();
  try {
    const response = await boundedOperation(
      () =>
        clients.fetch(
          `http://127.0.0.1:${server.address().port}/v1/categories`,
          { method: 'GET', headers: {}, signal: AbortSignal.timeout(1000) },
        ),
      100,
    );
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  } finally {
    clients.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
