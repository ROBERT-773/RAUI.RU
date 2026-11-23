import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendResetSmtp } from './modules/auth/reset-smtp';

test('Reset SMTP rejects header injection and malformed tokens before connecting', async () => {
  for (const message of [
    {
      destination: 'a@example.org\r\nBcc: thief@example.org',
      token: 'a'.repeat(43),
    },
    { destination: 'a@example.org,b@example.org', token: 'a'.repeat(43) },
    { destination: 'a@example.org', token: 'invalid' },
  ])
    await assert.rejects(
      sendResetSmtp(message, {
        WEB_ORIGIN: 'https://staging.raui.ru',
        RESET_SMTP_PASSWORD: 'test-only',
      }),
      /Verification delivery unavailable/,
    );
});

import { before, after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, connect, type TLSSocket } from 'node:tls';
import { once } from 'node:events';
let directory: string;
let cert: Buffer;
let key: Buffer;
let wrongCert: Buffer;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'raui-smtp-test-'));
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
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
      '-subj',
      '/CN=mail.nic.ru',
      '-addext',
      'subjectAltName=DNS:mail.nic.ru',
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-key',
      join(directory, 'key.pem'),
      '-days',
      '1',
      '-out',
      join(directory, 'wrong.pem'),
      '-subj',
      '/CN=other.example',
      '-addext',
      'subjectAltName=DNS:other.example',
    ],
    { stdio: 'ignore' },
  );
  wrongCert = readFileSync(join(directory, 'wrong.pem'));
  cert = readFileSync(join(directory, 'cert.pem'));
  key = readFileSync(join(directory, 'key.pem'));
});
after(() => rmSync(directory, { recursive: true, force: true }));
async function smtpServer(
  stall?: string,
  rejectAt?: string,
  serverCert = cert,
) {
  const commands: string[] = [];
  const sockets = new Set<TLSSocket>();
  let data = '';
  let encrypted = true;
  const server = createServer({ key, cert: serverCert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    encrypted &&= socket.encrypted;
    if (stall !== 'greeting') socket.write('220 test SMTP\r\n');
    let buffer = '';
    let auth = 0;
    let inData = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== '.') {
            data += line + '\r\n';
            continue;
          }
          inData = false;
          if (stall === 'data') continue;
          socket.write('250 accepted\r\n');
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO')) {
          if (stall !== 'ehlo')
            socket.write('250-test\r\n250 AUTH LOGIN PLAIN CRAM-MD5\r\n');
        } else if (line === 'AUTH LOGIN') {
          auth = 1;
          if (stall !== 'auth') socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (auth === 1) {
          auth = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (auth === 2) {
          auth = 0;
          socket.write(
            rejectAt === 'auth'
              ? '535 rejected private detail\r\n'
              : '235 authenticated\r\n',
          );
        } else if (line.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
        else if (line.startsWith('RCPT TO'))
          socket.write(
            rejectAt === 'recipient'
              ? '550 private recipient detail\r\n'
              : '250 OK\r\n',
          );
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 send data\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    commands,
    sockets,
    get data() {
      return data;
    },
    get encrypted() {
      return encrypted;
    },
    port: address.port,
    connector: (options: import('node:tls').ConnectionOptions) =>
      connect({
        ...options,
        host: '127.0.0.1',
        port: address.port,
        ca: serverCert,
      }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const config = {
  WEB_ORIGIN: 'https://staging.raui.ru',
  RESET_SMTP_PASSWORD: 'synthetic-password',
};
const message = { destination: 'recipient@example.org', token: 'a'.repeat(43) };
test('Verified implicit TLS authenticates with LOGIN and delivers an exact fragment reset link', async () => {
  const server = await smtpServer();
  try {
    await sendResetSmtp(message, config, server.connector);
    assert.equal(server.encrypted, true);
    assert.ok(server.commands.includes('AUTH LOGIN'));
    assert.ok(
      server.commands.includes(
        Buffer.from('noreply@raui.ru').toString('base64'),
      ),
    );
    assert.ok(server.commands.includes('MAIL FROM:<noreply@raui.ru>'));
    assert.ok(server.commands.includes('RCPT TO:<recipient@example.org>'));
    const body = Buffer.from(
      server.data.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''),
      'base64',
    ).toString();
    assert.ok(
      body.includes(
        `https://staging.raui.ru/account/reset-password#token=${message.token}`,
      ),
    );
    assert.ok(body.includes('15 минут'));
  } finally {
    await server.close();
  }
});
test('Authentication and recipient rejections expose only a sanitized delivery error', async () => {
  for (const stage of ['auth', 'recipient']) {
    const server = await smtpServer(undefined, stage);
    try {
      await assert.rejects(
        sendResetSmtp(message, config, server.connector),
        (error: Error) => error.message === 'Verification delivery unavailable',
      );
    } finally {
      await server.close();
    }
  }
});
test('Untrusted TLS certificates prevent AUTH and all SMTP commands', async () => {
  const server = await smtpServer();
  try {
    await assert.rejects(
      sendResetSmtp(message, config, (options) =>
        connect({ ...options, host: '127.0.0.1', port: server.port }),
      ),
    );
    assert.deepEqual(server.commands, []);
  } finally {
    await server.close();
  }
});
test('One five-second deadline actively closes greeting, EHLO, AUTH and DATA stalls with no late commands', async () => {
  await Promise.all(
    ['greeting', 'ehlo', 'auth', 'data'].map(async (stage) => {
      const server = await smtpServer(stage);
      try {
        const started = performance.now();
        await assert.rejects(
          sendResetSmtp(message, config, server.connector),
          /Verification delivery unavailable/,
        );
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 4800 && elapsed < 5700, `${stage}: ${elapsed}`);
        const count = server.commands.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(server.sockets.size, 0, stage);
        assert.equal(server.commands.length, count, stage);
        if (stage !== 'data') assert.ok(!server.commands.includes('DATA'));
      } finally {
        await server.close();
      }
    }),
  );
});

test('Malformed origins never expose raw URL errors', async () => {
  await assert.rejects(
    sendResetSmtp(message, {
      ...config,
      WEB_ORIGIN: 'https://private-secret@[',
    }),
    (error: Error) => error.message === 'Verification delivery unavailable',
  );
});

import { ConfiguredDelivery } from './modules/auth/delivery';
test('HTTPS gateway takes priority without SMTP fallback while email/phone keep local behavior', async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    process.env.WEB_ORIGIN = config.WEB_ORIGIN;
    process.env.DATABASE_URL = 'postgresql://localhost/raui';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.RESET_SMTP_ENABLED = 'true';
    process.env.RESET_SMTP_PASSWORD = config.RESET_SMTP_PASSWORD;
    process.env.VERIFICATION_GATEWAY_URL = 'https://gateway.example/send';
    process.env.VERIFICATION_GATEWAY_TOKEN = 'test-only';
    let received: unknown;
    globalThis.fetch = async (_url, options) => {
      received = JSON.parse(String(options?.body));
      return new Response(null, { status: 200 });
    };
    const delivery = new ConfiguredDelivery();
    const invalid = {
      destination: message.destination,
      token: 'invalid',
      purpose: 'reset' as const,
    };
    await delivery.send(invalid);
    assert.deepEqual(received, invalid);
    globalThis.fetch = async () => {
      throw new Error('private-password');
    };
    await assert.rejects(
      delivery.send(invalid),
      /Verification delivery unavailable/,
    );
    delete process.env.VERIFICATION_GATEWAY_URL;
    delete process.env.VERIFICATION_GATEWAY_TOKEN;
    process.env.LOCAL_PRIVATE_DIR = join(directory, 'local');
    for (const purpose of ['email', 'phone'] as const)
      await delivery.send({ ...invalid, purpose });
    const lines = readFileSync(
      join(directory, 'local/verification/messages.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    await assert.rejects(
      delivery.send(invalid),
      /Verification delivery unavailable/,
    );
    assert.equal(
      readFileSync(join(directory, 'local/verification/messages.jsonl'), 'utf8')
        .trim()
        .split('\n').length,
      2,
    );
  } finally {
    process.env = previous;
    globalThis.fetch = originalFetch;
  }
});

import { createServer as createTcpServer } from 'node:net';
test('Deadline destroys pending DNS and TLS sockets and ignores late DNS completion', async () => {
  await Promise.all([
    (async () => {
      const server = await smtpServer();
      let pending: TLSSocket | undefined;
      let lookupTimer: NodeJS.Timeout | undefined;
      try {
        await assert.rejects(
          sendResetSmtp(message, config, (options) => {
            assert.equal(options.rejectUnauthorized, true);
            assert.equal(options.servername, 'mail.nic.ru');
            pending = connect({
              ...options,
              port: server.port,
              ca: cert,
              lookup(_host, _options, callback) {
                lookupTimer = setTimeout(
                  () => callback(null, [{ address: '127.0.0.1', family: 4 }]),
                  5200,
                );
              },
            });
            return pending;
          }),
          /Verification delivery unavailable/,
        );
        assert.equal(pending?.destroyed, true);
        pending?.emit('secureConnect');
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(server.commands, []);
      } finally {
        clearTimeout(lookupTimer);
        await server.close();
      }
    })(),
    (async () => {
      const sockets = new Set<import('node:net').Socket>();
      let bytes = Buffer.alloc(0);
      const server = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on('data', (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
        });
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      try {
        await assert.rejects(
          sendResetSmtp(message, config, (options) =>
            connect({ ...options, host: '127.0.0.1', port: address.port }),
          ),
          /Verification delivery unavailable/,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(sockets.size, 0);
        assert.ok(!bytes.includes(Buffer.from(config.RESET_SMTP_PASSWORD)));
        assert.ok(!bytes.includes(Buffer.from('AUTH LOGIN')));
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    })(),
  ]);
});

test('A trusted certificate for the wrong hostname cannot authenticate', async () => {
  const server = await smtpServer(undefined, undefined, wrongCert);
  try {
    await assert.rejects(
      sendResetSmtp(message, config, server.connector),
      /Verification delivery unavailable/,
    );
    assert.deepEqual(server.commands, []);
  } finally {
    await server.close();
  }
});
test('Unsafe origins fail before opening any connection', async () => {
  let connections = 0;
  for (const origin of [
    'http://staging.raui.ru',
    'https://user:secret@staging.raui.ru',
    'https://staging.raui.ru/path',
    'https://staging.raui.ru?private=secret',
    'https://staging.raui.ru#secret',
  ]) {
    await assert.rejects(
      sendResetSmtp(message, { ...config, WEB_ORIGIN: origin }, () => {
        connections++;
        throw new Error('Unexpected connection');
      }),
      /Verification delivery unavailable/,
    );
  }
  assert.equal(connections, 0);
});
