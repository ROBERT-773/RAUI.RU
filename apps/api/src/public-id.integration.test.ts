import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { VerificationDelivery } from './modules/auth/delivery';

interface PublicUser {
  id: string;
  public_id: string;
  display_name: string;
  private_fixture?: string;
  password_hash?: string;
}
interface LoginResponse {
  user: PublicUser;
  sessionToken: string;
}

test('Permanent numeric user IDs survive profile changes, migration reruns and sessions without exposing private columns', async () => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VerificationDelivery)
    .useValue({ send: async () => {} })
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = async <T = PublicUser>(path: string, body: unknown) => {
    const response = await fetch(base + '/v1/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    return (await response.json()) as T;
  };
  try {
    const input = {
      email: 'numeric-id@example.test',
      password: 'Long-test-password-42',
      displayName: 'Numeric user',
    };
    const first = await post('register', input);
    assert.match(first.public_id, /^[1-9][0-9]*$/);
    await pool.query(
      "SELECT setval('users_public_id_seq',9007199254740992,true)",
    );
    const second = await post('register', {
      ...input,
      email: 'other-id@example.test',
    });
    assert.notEqual(second.public_id, first.public_id);
    assert.equal(second.public_id, '9007199254740993');
    await assert.rejects(
      pool.query('UPDATE users SET public_id=$2 WHERE id=$1', [
        first.id,
        second.public_id,
      ]),
    );
    await assert.rejects(
      pool.query('UPDATE users SET public_id=DEFAULT WHERE id=$1', [first.id]),
      /immutable/,
    );
    const schema = (await (await fetch(base + '/v1/openapi.json')).json()) as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<
              string,
              {
                content: Record<
                  string,
                  { schema: { properties: Record<string, { type: string }> } }
                >;
              }
            >;
          };
        }
      >;
    };
    assert.equal(
      schema.paths['/v1/auth/me']!.get.responses['200']!.content[
        'application/json'
      ]!.schema.properties.public_id!.type,
      'string',
    );
    await pool.query(
      "ALTER TABLE users ADD COLUMN private_fixture text DEFAULT 'never expose'",
    );
    const login = await post<LoginResponse>('login', {
      email: input.email,
      password: input.password,
      transport: 'bearer',
    });
    assert.equal(login.user.public_id, first.public_id);
    assert.equal(login.user.private_fixture, undefined);
    assert.equal(login.user.password_hash, undefined);
    await pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [
      first.id,
      'Renamed',
    ]);
    await migrate(pool);
    const response = await fetch(base + '/v1/auth/me', {
      headers: { Authorization: 'Bearer ' + login.sessionToken },
    });
    assert.equal(response.status, 200);
    const me = (await response.json()) as PublicUser;
    assert.equal(me.public_id, first.public_id);
    assert.equal(me.display_name, 'Renamed');
    assert.equal(me.private_fixture, undefined);
    assert.equal(me.password_hash, undefined);
  } finally {
    await app.close();
    await pool.end();
  }
});
