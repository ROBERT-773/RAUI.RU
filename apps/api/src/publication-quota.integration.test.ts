import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { migrate } from './modules/database/migrate';
import { hash, token, type Actor } from './common/security';
import { PublicationQuotas } from './modules/listings/publication-quota';

type Account = { id: string; secret: string };
type Offer = { property: string; listing: string; caseId: string };

test(
  'owner publication quota enforces real HTTP and PostgreSQL transaction boundaries',
  { timeout: 90000 },
  async (t) => {
    assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await migrate(pool);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });
    configure(app);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function account(role = 'owner'): Promise<Account> {
      const id = randomUUID(),
        secret = token();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'fixture','Quota fixture',$3,now(),now())",
        [id, `${id}@example.test`, role],
      );
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [id, hash(secret), hash(token())],
      );
      return { id, secret };
    }
    async function call(
      path: string,
      actor?: Account,
      method = 'GET',
      body?: unknown,
      key = randomUUID(),
    ) {
      return fetch(base + '/v1' + path, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(actor ? { Authorization: 'Bearer ' + actor.secret } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function offer(
      actor: Account,
      status = 'moderation',
      property?: string,
    ): Promise<Offer> {
      const listing = randomUUID(),
        source = randomUUID(),
        caseId = randomUUID();
      if (!property) {
        property = randomUUID();
        const address = randomUUID();
        await pool.query(
          "INSERT INTO addresses(id,formatted,locality,point) VALUES($1,'Quota fixture','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326))",
          [address],
        );
        await pool.query(
          "INSERT INTO properties(id,created_by,category_code,address_id,attributes) VALUES($1,$2,'apartment',$3,'{\"area\":55}')",
          [property, actor.id, address],
        );
      }
      await pool.query(
        "INSERT INTO listing_sources(id,kind) VALUES($1,'direct')",
        [source],
      );
      await pool.query(
        "INSERT INTO listings(id,property_id,source_id,seller_id,deal_type,title,price,status) VALUES($1,$2,$3,$4,'sale','Quota fixture',1000000,$5)",
        [listing, property, source, actor.id, status],
      );
      await pool.query(
        "INSERT INTO media(listing_id,uploaded_by,kind,original_key,mime,state) VALUES($1,$2,'photo','quota-fixture.jpg','image/jpeg','ready')",
        [listing, actor.id],
      );
      if (status === 'moderation')
        await pool.query(
          'INSERT INTO moderation_cases(id,listing_id,listing_version) VALUES($1,$2,1)',
          [caseId, listing],
        );
      return { property, listing, caseId };
    }
    async function seed(actor: Account, n: number) {
      const offers: Offer[] = [];
      for (let i = 0; i < n; i++) offers.push(await offer(actor, 'published'));
      return offers;
    }
    async function snapshot(actor: Account, n: number) {
      const response = await call('/account/publication-quota', actor);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        applies: true,
        limit: 6,
        publishedObjects: n,
        remaining: Math.max(0, 6 - n),
      });
    }
    const admin = await account('admin');
    const approve = (item: Offer, key = randomUUID()) =>
      call(
        `/admin/moderation/${item.caseId}/decision`,
        admin,
        'POST',
        { decision: 'approve', reason: 'Quota acceptance review' },
        key,
      );
    async function state(item: Offer) {
      return (
        await pool.query(
          'SELECT l.status,l.version,c.state,c.reviewer_id,c.reason,c.resolved_at,(SELECT count(*)::int FROM listing_history h WHERE h.listing_id=l.id) AS history FROM listings l JOIN moderation_cases c ON c.listing_id=l.id WHERE c.id=$1',
          [item.caseId],
        )
      ).rows[0];
    }
    async function denied(item: Offer) {
      const before = await state(item),
        response = await approve(item);
      assert.equal(response.status, 409);
      const body = (await response.json()) as { code: string; message: string };
      assert.equal(body.code, 'OWNER_PUBLICATION_QUOTA_EXCEEDED');
      assert.match(body.message, /6 объектов/);
      assert.deepEqual(await state(item), before);
    }
    async function pause(actor: Account, item: Offer) {
      const row = (
        await pool.query('SELECT version FROM listings WHERE id=$1', [
          item.listing,
        ])
      ).rows[0];
      assert.equal(
        (
          await call(`/listings/${item.listing}/transitions`, actor, 'POST', {
            version: row.version,
            status: 'paused',
          })
        ).status,
        201,
      );
    }
    // Observe a real blocked database query, rather than relying on elapsed time.
    async function blocked(client: PoolClient) {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND state='active'",
          [pid],
        );
        if (rows.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('Expected approval to wait for the held seller row lock');
    }
    try {
      await t.test(
        'own snapshot counts distinct published Properties and isolates sellers',
        async () => {
          const owner = await account(),
            stranger = await account();
          const [first] = await seed(owner, 4);
          await offer(owner, 'published', first!.property);
          for (const status of [
            'draft',
            'processing',
            'moderation',
            'paused',
            'archived',
            'sold',
            'rented',
            'rejected',
          ])
            await offer(owner, status);
          await seed(stranger, 7);
          await snapshot(owner, 4);
          await snapshot(stranger, 7);
          assert.equal((await call('/account/publication-quota')).status, 401);
          for (const role of [
            'buyer',
            'agent',
            'agency',
            'developer',
            'admin',
          ]) {
            const response = await call(
              '/account/publication-quota',
              await account(role),
            );
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
              applies: false,
              limit: null,
              publishedObjects: null,
              remaining: null,
            });
          }
        },
      );
      await t.test(
        'sixth publishes; denied seventh stays pending and same request succeeds after release',
        async () => {
          const owner = await account(),
            previous = await seed(owner, 5);
          const sixth = await offer(owner),
            seventh = await offer(owner);
          assert.equal((await approve(sixth)).status, 201);
          await denied(seventh);
          await snapshot(owner, 6);
          await pause(owner, previous[0]!);
          assert.equal((await approve(seventh)).status, 201);
          await snapshot(owner, 6);
        },
      );
      await t.test(
        'legacy seven remain published and counted Property offers consume no extra slot',
        async () => {
          const owner = await account(),
            previous = await seed(owner, 7);
          const same = await offer(owner, 'moderation', previous[0]!.property);
          assert.equal((await approve(same)).status, 201);
          await snapshot(owner, 7);
          await denied(await offer(owner));
          await pause(owner, previous[0]!);
          await snapshot(owner, 7);
          await pause(owner, same);
          await snapshot(owner, 6);
        },
      );
      await t.test(
        'concurrent sixth and seventh serialize while same Property offers both publish',
        async () => {
          for (const shared of [false, true]) {
            const owner = await account();
            await seed(owner, 5);
            const first = await offer(owner),
              second = await offer(
                owner,
                'moderation',
                shared ? first.property : undefined,
              );
            const holder = await pool.connect();
            try {
              await holder.query('BEGIN');
              await holder.query(
                'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
                [owner.id],
              );
              const results = Promise.all([approve(first), approve(second)]);
              await blocked(holder);
              await holder.query('COMMIT');
              const responses = await results;
              assert.deepEqual(
                responses.map((r) => r.status).sort(),
                shared ? [201, 201] : [201, 409],
              );
              await snapshot(owner, 6);
              if (!shared) {
                const losing = responses[0]!.status === 409 ? first : second;
                assert.deepEqual(await state(losing), {
                  status: 'moderation',
                  version: 1,
                  state: 'pending',
                  reviewer_id: null,
                  reason: null,
                  resolved_at: null,
                  history: 0,
                });
              }
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          }
        },
      );
      await t.test(
        'current locked role, activation, contacts and registration defeat stale seller state',
        async () => {
          for (const mutation of [
            "role='buyer'",
            'active=false',
            'email_verified_at=NULL',
            'phone_verified_at=NULL',
            "registration_approval_state='pending'",
            "registration_approval_state='rejected'",
          ]) {
            const owner = await account(),
              pending = await offer(owner),
              before = await state(pending);
            const holder = await pool.connect();
            try {
              await holder.query('BEGIN');
              await holder.query(`UPDATE users SET ${mutation} WHERE id=$1`, [
                owner.id,
              ]);
              const result = approve(pending);
              await blocked(holder);
              await holder.query('COMMIT');
              const response = await result;
              assert.ok(
                [403, 409].includes(response.status),
                `${mutation}: ${response.status}`,
              );
              assert.deepEqual(await state(pending), before);
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          }
          const agent = await account('agent');
          await seed(agent, 6);
          const pending = await offer(agent);
          await pool.query("UPDATE users SET role='owner' WHERE id=$1", [
            agent.id,
          ]);
          await denied(pending);
        },
      );
      await t.test(
        'organization and API source publications remain charged to original seller',
        async () => {
          const owner = await account(),
            colleague = await account(),
            organization = randomUUID();
          const existing = await seed(owner, 6);
          await seed(colleague, 2);
          await pool.query(
            "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Quota agency','agency',$2)",
            [organization, colleague.id],
          );
          for (const actor of [owner, colleague])
            await pool.query(
              "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
              [organization, actor.id],
            );
          for (const item of existing) {
            await pool.query(
              'UPDATE properties SET organization_id=$2 WHERE id=$1',
              [item.property, organization],
            );
            await pool.query(
              'UPDATE listings SET organization_id=$2 WHERE id=$1',
              [item.listing, organization],
            );
            await pool.query(
              "UPDATE listing_sources SET kind='api',organization_id=$2 WHERE id=(SELECT source_id FROM listings WHERE id=$1)",
              [item.listing, organization],
            );
          }
          await snapshot(owner, 6);
          await snapshot(colleague, 2);
          const pending = await offer(owner);
          await pool.query(
            'UPDATE properties SET organization_id=$2 WHERE id=$1',
            [pending.property, organization],
          );
          await pool.query(
            'UPDATE listings SET organization_id=$2 WHERE id=$1',
            [pending.listing, organization],
          );
          await pool.query(
            "UPDATE listing_sources SET kind='api',organization_id=$2 WHERE id=(SELECT source_id FROM listings WHERE id=$1)",
            [pending.listing, organization],
          );
          await denied(pending);
        },
      );
      await t.test(
        'republishing paused offer needs a free slot; final archive sale and rental release slots',
        async () => {
          const owner = await account(),
            existing = await seed(owner, 6);
          await pause(owner, existing[0]!);
          assert.equal((await approve(await offer(owner))).status, 201);
          const item = existing[0]!;
          assert.equal(
            (
              await call(
                `/listings/${item.listing}/transitions`,
                owner,
                'POST',
                { version: 2, status: 'processing' },
              )
            ).status,
            201,
          );
          assert.equal(
            (
              await call(
                `/listings/${item.listing}/transitions`,
                owner,
                'POST',
                { version: 3, status: 'moderation' },
              )
            ).status,
            201,
          );
          const pending = (
            await pool.query(
              "SELECT id FROM moderation_cases WHERE listing_id=$1 AND state='pending'",
              [item.listing],
            )
          ).rows[0];
          await denied({ ...item, caseId: pending.id });
          for (const [index, status] of [
            'archived',
            'sold',
            'rented',
          ].entries()) {
            const current = existing[index + 1]!;
            if (status === 'rented')
              await pool.query(
                "UPDATE listings SET deal_type='long_rent' WHERE id=$1",
                [current.listing],
              );
            assert.equal(
              (
                await call(
                  `/listings/${current.listing}/transitions`,
                  owner,
                  'POST',
                  { version: 1, status },
                )
              ).status,
              201,
            );
            await snapshot(owner, 5 - index);
          }
        },
      );
      await t.test(
        'agent to owner and owner to agent changes are read after seller mutex wait',
        async () => {
          for (const startingRole of ['owner', 'agent']) {
            const actor = await account(startingRole);
            await seed(actor, 6);
            const pending = await offer(actor);
            const holder = await pool.connect();
            try {
              await holder.query('BEGIN');
              await holder.query('UPDATE users SET role=$2 WHERE id=$1', [
                actor.id,
                startingRole === 'owner' ? 'agent' : 'owner',
              ]);
              const result = approve(pending);
              await blocked(holder);
              await holder.query('COMMIT');
              assert.equal(
                (await result).status,
                startingRole === 'owner' ? 201 : 409,
              );
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          }
        },
      );
      await t.test(
        'idempotency replays do not republish after pause and mismatched payload stays generic conflict',
        async () => {
          const owner = await account();
          await seed(owner, 5);
          const pending = await offer(owner),
            key = randomUUID();
          assert.equal((await approve(pending, key)).status, 201);
          await pause(owner, pending);
          assert.equal((await approve(pending, key)).status, 201);
          assert.equal(
            (
              await pool.query('SELECT status FROM listings WHERE id=$1', [
                pending.listing,
              ])
            ).rows[0].status,
            'paused',
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM listing_history WHERE listing_id=$1 AND event='moderation.decided'",
                [pending.listing],
              )
            ).rows[0].n,
            1,
          );
          const response = await call(
            `/admin/moderation/${pending.caseId}/decision`,
            admin,
            'POST',
            { decision: 'reject', reason: 'Different decision payload' },
            key,
          );
          assert.equal(response.status, 409);
          assert.notEqual(
            ((await response.json()) as { code?: string }).code,
            'OWNER_PUBLICATION_QUOTA_EXCEEDED',
          );
        },
      );
      await t.test(
        'seller foreign key KEY SHARE is compatible with publication mutex',
        async () => {
          const owner = await account(),
            pending = await offer(owner),
            holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query("SET LOCAL lock_timeout='2s'");
            await holder.query(
              "INSERT INTO audit_events(actor_id,action,entity_type,entity_id,data) VALUES($1,'quota.fixture','user',$2,'{}')",
              [owner.id, owner.id],
            );
            // FK insertion retains KEY SHARE until rollback; approval must complete while it is held.
            assert.equal((await approve(pending)).status, 201);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
      await t.test(
        'same Property consumes an independent slot for each original seller',
        async () => {
          const first = await account(),
            second = await account(),
            organization = randomUUID();
          const firstOffers = await seed(first, 6),
            secondOffers = await seed(second, 6);
          const shared = firstOffers[0]!;
          await pool.query(
            "INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'Shared property agency','agency',$2)",
            [organization, first.id],
          );
          for (const actor of [first, second])
            await pool.query(
              "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
              [organization, actor.id],
            );
          await pool.query(
            'UPDATE properties SET organization_id=$2 WHERE id=$1',
            [shared.property, organization],
          );
          const pending = await offer(second, 'moderation', shared.property);
          await denied(pending);
          await pause(second, secondOffers[0]!);
          assert.equal((await approve(pending)).status, 201);
          await snapshot(first, 6);
          await snapshot(second, 6);
          await pause(first, shared);
          await snapshot(first, 5);
          await snapshot(second, 6);
        },
      );
      await t.test(
        'active paid Standard ranking promotion cannot raise publication quota',
        async () => {
          const owner = await account();
          await seed(owner, 6);
          const pending = await offer(owner);
          const product = randomUUID(),
            payment = randomUUID();
          // Synthetic captured payment/promotion state isolates publication policy; no provider flow is exercised.
          await pool.query(
            "INSERT INTO commerce_promotion_products(id,code,kind,version,price_minor,currency,duration_hours,priority,enabled) VALUES($1,$2,'standard',1,10000,'RUB',24,1,true)",
            [product, randomUUID()],
          );
          await pool.query(
            "INSERT INTO commerce_payment_orders(id,account_id,provider,reference,idempotency_key,amount_minor,currency,state) VALUES($1,$2,'quota-fixture',$3,$4,10000,'RUB','captured')",
            [payment, owner.id, randomUUID(), randomUUID()],
          );
          await pool.query(
            "INSERT INTO commerce_promotion_activations(account_id,listing_id,promotion_product_id,payment_order_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 day','active')",
            [owner.id, pending.listing, product, payment],
          );
          await denied(pending);
          await snapshot(owner, 6);
        },
      );
      await t.test(
        'HTTP draft creation and moderation submission remain available at full capacity',
        async () => {
          const owner = await account();
          await seed(owner, 6);
          const propertyFixture = await offer(owner, 'draft');
          const response = await call('/listings', owner, 'POST', {
            propertyId: propertyFixture.property,
            dealType: 'sale',
            title: 'Draft at full capacity',
            price: 1000000,
          });
          assert.equal(response.status, 201);
          const draft = (await response.json()) as {
            id: string;
            status: string;
            version: number;
          };
          assert.equal(draft.status, 'draft');
          await pool.query(
            "INSERT INTO media(listing_id,uploaded_by,kind,original_key,mime,state) VALUES($1,$2,'photo','quota-draft.jpg','image/jpeg','ready')",
            [draft.id, owner.id],
          );
          for (const [offset, status] of [
            'processing',
            'moderation',
          ].entries()) {
            assert.equal(
              (
                await call(`/listings/${draft.id}/transitions`, owner, 'POST', {
                  version: draft.version + offset,
                  status,
                })
              ).status,
              201,
            );
            await snapshot(owner, 6);
          }
          const current = (
            await pool.query(
              "SELECT id FROM moderation_cases WHERE listing_id=$1 AND state='pending'",
              [draft.id],
            )
          ).rows[0];
          assert.ok(current);
          await denied({
            property: propertyFixture.property,
            listing: draft.id,
            caseId: current.id,
          });
        },
      );
      await t.test(
        'own service rejects stale authenticated account snapshots',
        async () => {
          const owner = await account();
          await seed(owner, 2);
          const stale: Actor = {
            id: owner.id,
            role: 'owner',
            session_id: randomUUID(),
            email_verified_at: new Date().toISOString(),
            phone_verified_at: new Date().toISOString(),
            registration_approval_state: 'approved',
          };
          const quotas = app.get(PublicationQuotas);
          await pool.query("UPDATE users SET role='agent' WHERE id=$1", [
            owner.id,
          ]);
          assert.deepEqual(await quotas.own(stale), {
            applies: false,
            limit: null,
            publishedObjects: null,
            remaining: null,
          });
          await pool.query(
            "UPDATE users SET registration_approval_state='rejected' WHERE id=$1",
            [owner.id],
          );
          await assert.rejects(quotas.own(stale), { status: 403 });
          await pool.query(
            "UPDATE users SET registration_approval_state='approved',active=false WHERE id=$1",
            [owner.id],
          );
          await assert.rejects(quotas.own(stale), { status: 401 });
        },
      );
      await t.test(
        'fresh own status denies pending, rejected and inactive accounts',
        async () => {
          for (const mutation of [
            "registration_approval_state='pending'",
            "registration_approval_state='rejected'",
            'active=false',
          ]) {
            const owner = await account();
            await pool.query(`UPDATE users SET ${mutation} WHERE id=$1`, [
              owner.id,
            ]);
            assert.ok(
              [401, 403].includes(
                (await call('/account/publication-quota', owner)).status,
              ),
            );
          }
        },
      );
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
