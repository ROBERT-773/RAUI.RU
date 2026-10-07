import { SearchModule } from './modules/search/search';
import { DatabaseModule } from './modules/database/database';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configure } from './bootstrap';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import { Actor, hash, token } from './common/security';
import {
  CommerceService,
  PaymentProvider,
  ProviderPayment,
  ProviderSnapshot,
  ProviderWebhook,
  PaidPlacementService,
} from './modules/commerce/commerce';
import { CommerceFeatures } from './modules/commerce/features';
import { PaymentReconciliation } from './modules/commerce/reconciliation';
import { Operations } from './modules/operations/operations';
class TestPaymentProvider extends PaymentProvider {
  readonly name = 'test';
  readonly configured = true;
  readonly secret = 'test-only-32-character-webhook-key';
  readonly snapshots = new Map<string, ProviderSnapshot>();
  readonly charges = new Map<string, ProviderPayment>();
  fail = false;
  lookupCount = 0;
  hold: (() => Promise<void>) | undefined;
  async createPayment(input: {
    idempotencyKey: string;
    amountMinor: number;
    currency: string;
  }): Promise<ProviderPayment> {
    let payment = this.charges.get(input.idempotencyKey);
    if (!payment) {
      payment = {
        providerId: 'provider-' + input.idempotencyKey,
        state: 'pending',
      };
      this.charges.set(input.idempotencyKey, payment);
      this.snapshots.set(payment.providerId, {
        ...payment,
        amountMinor: input.amountMinor,
        currency: input.currency,
      });
    }
    return payment;
  }
  async refundPayment(): Promise<ProviderPayment> {
    return { providerId: 'unused', state: 'refunded' };
  }
  async lookupPayment(providerId: string): Promise<ProviderSnapshot> {
    this.lookupCount++;
    if (this.hold) await this.hold();
    if (this.fail) throw new Error('Unavailable');
    const result = this.snapshots.get(providerId);
    assert.ok(result);
    return result;
  }
  async verifyWebhook(signature: string, payload: Buffer) {
    return (
      signature ===
      createHmac('sha256', this.secret).update(payload).digest('hex')
    );
  }
  async parseWebhook(payload: Buffer): Promise<ProviderWebhook> {
    return JSON.parse(payload.toString('utf8')) as ProviderWebhook;
  }
}
test('Phase 4A real PostgreSQL and HTTP commercial acceptance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);
  await migrate(pool);
  const provider = new TestPaymentProvider();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PaymentProvider)
    .useValue(provider)
    .compile();
  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });
  configure(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(Database),
    commerce = app.get(CommerceService),
    features = app.get(CommerceFeatures),
    worker = app.get(PaymentReconciliation),
    paid = app.get(PaidPlacementService),
    base = await app.getUrl();
  const actors: Actor[] = [],
    secrets: string[] = [];
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    secret?: string,
    key?: string,
  ) {
    return fetch(base + '/v1/commerce' + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(secret ? { authorization: 'Bearer ' + secret } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  let listingId = '',
    otherListingId = '',
    orderId = '',
    paymentId = '',
    activationId = '',
    campaignId = '';
  const orderBody = {
    amountMinor: 9900,
    currency: 'RUB',
    reference: 'listing-promotion',
    provider: 'test',
  };
  try {
    for (const role of ['owner', 'admin', 'buyer', 'owner'] as const) {
      const id = randomUUID(),
        sessionId = randomUUID(),
        secret = token();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,display_name,role,email_verified_at,phone_verified_at) VALUES($1,$2,'not-a-login-hash','Test',$3,now(),now())",
        [id, id + '@example.test', role],
      );
      await pool.query(
        "INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
        [sessionId, id, hash(secret), hash(token())],
      );
      actors.push({
        id,
        role,
        email_verified_at: 'verified',
        phone_verified_at: 'verified',
        session_id: sessionId,
      });
      secrets.push(secret);
    }
    const owner = actors[0]!,
      admin = actors[1]!;
    for (const sellerId of [owner.id, actors[3]!.id]) {
      const [address] = await db.rows<{ id: string }>(
        "INSERT INTO addresses(formatted,locality,point) VALUES('Test address','Москва',ST_SetSRID(ST_MakePoint(37.6,55.7),4326)) RETURNING id",
      );
      assert.ok(address);
      const [property] = await db.rows<{ id: string }>(
        "INSERT INTO properties(created_by,category_code,address_id,attributes) VALUES($1,'apartment',$2,'{\"area\":50}') RETURNING id",
        [sellerId, address.id],
      );
      assert.ok(property);
      const [source] = await db.rows<{ id: string }>(
        "INSERT INTO listing_sources(kind) VALUES('direct') RETURNING id",
      );
      assert.ok(source);
      const [listing] = await db.rows<{ id: string }>(
        "INSERT INTO listings(property_id,source_id,seller_id,deal_type,title,price,status,published_at) VALUES($1,$2,$3,'sale','Test listing',10000000,'published',now()) RETURNING id",
        [property.id, source.id, sellerId],
      );
      assert.ok(listing);
      if (!listingId) listingId = listing.id;
      else otherListingId = listing.id;
    }
    await t.test(
      'standalone search-worker module resolves the paid-placement read boundary',
      async () => {
        const context = await Test.createTestingModule({
          imports: [DatabaseModule, SearchModule],
        }).compile();
        await context.close();
      },
    );
    await t.test(
      'migration 004 is repeatable and commercial flags default off',
      async () => {
        assert.equal(
          (await pool.query('SELECT count(*) FROM schema_migrations')).rows[0]
            .count,
          '13',
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*) FROM commerce_feature_flags WHERE enabled',
            )
          ).rows[0].count,
          '0',
        );
        await assert.rejects(
          commerce.createOrder(owner, 'order-key-001', orderBody),
          /disabled/,
        );
        assert.deepEqual(await paid.signals([listingId]), []);
      },
    );
    await t.test(
      'admin controls require verified admin, optimistic version and immutable audit',
      async () => {
        assert.equal((await call('/features')).status, 401);
        assert.equal(
          (await call('/features', 'GET', undefined, secrets[2])).status,
          403,
        );
        assert.equal(
          (
            await call(
              '/features/payments',
              'PATCH',
              { enabled: true, version: 1 },
              secrets[1],
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              '/features/payments',
              'PATCH',
              { enabled: false, version: 1 },
              secrets[1],
            )
          ).status,
          409,
        );
        await features.configure(admin, 'promotions', {
          enabled: true,
          version: 1,
        });
        await features.configure(admin, 'advertising', {
          enabled: true,
          version: 1,
        });
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM audit_events WHERE action='commerce.flag.changed'",
            )
          ).rows[0].count,
          '3',
        );
      },
    );
    await t.test(
      'payment orders are concurrent-idempotent and reject altered payloads/card fields',
      async () => {
        const orders = await Promise.all([
          commerce.createOrder(owner, 'order-key-001', orderBody),
          commerce.createOrder(owner, 'order-key-001', orderBody),
        ]);
        assert.equal(orders[0]!.id, orders[1]!.id);
        orderId = String(orders[0]!.id);
        await assert.rejects(
          commerce.createOrder(owner, 'order-key-001', {
            ...orderBody,
            amountMinor: 1,
          }),
          /Idempotency/,
        );
        assert.equal(
          (
            await call(
              '/orders',
              'POST',
              { ...orderBody, pan: '4111111111111111' },
              secrets[0],
              'bad-pan-001',
            )
          ).status,
          400,
        );
        assert.equal((await commerce.orders(actors[2]!)).length, 0);
      },
    );
    await t.test(
      'provider start uses stable idempotency key; reconciliation repairs missed capture webhook',
      async () => {
        const results = await Promise.all([
          commerce.startPayment(owner, orderId),
          commerce.startPayment(owner, orderId),
        ]);
        assert.equal(results[0].providerId, results[1].providerId);
        paymentId = results[0].providerId;
        assert.equal(provider.charges.size, 1);
        await assert.rejects(
          commerce.startPayment(actors[2]!, orderId),
          /Unknown/,
        );
        provider.snapshots.set(paymentId, {
          providerId: paymentId,
          state: 'captured',
          amountMinor: 9900,
          currency: 'RUB',
        });
        assert.equal((await worker.tick()).checked, 1);
        const [order] = await db.rows<{ state: string }>(
          'SELECT state FROM commerce_payment_orders WHERE id=$1',
          [orderId],
        );
        assert.equal(order!.state, 'captured');
        const events = await db.rows(
          'SELECT id FROM commerce_payment_events WHERE payment_order_id=$1',
          [orderId],
        );
        await pool.query(
          'UPDATE commerce_reconciliation_jobs SET available_at=now()',
        );
        await worker.tick();
        assert.equal(
          (
            await db.rows(
              'SELECT id FROM commerce_payment_events WHERE payment_order_id=$1',
              [orderId],
            )
          ).length,
          events.length,
        );
      },
    );
    await t.test(
      'reconciliation validates monetary binding, retries with backoff and honors kill switch',
      async () => {
        await pool.query(
          'UPDATE commerce_reconciliation_jobs SET available_at=now()',
        );
        provider.snapshots.set(paymentId, {
          providerId: paymentId,
          state: 'refunded',
          amountMinor: 1,
          currency: 'RUB',
        });
        await worker.tick();
        let [job] = await db.rows<{
          attempts: number;
          last_error: string;
          lease_token: string | null;
        }>('SELECT * FROM commerce_reconciliation_jobs WHERE order_id=$1', [
          orderId,
        ]);
        assert.equal(job!.attempts, 1);
        assert.equal(job!.last_error, 'provider_snapshot_failed');
        assert.equal(job!.lease_token, null);
        provider.fail = true;
        await pool.query(
          'UPDATE commerce_reconciliation_jobs SET available_at=now()',
        );
        await worker.tick();
        [job] = await db.rows<{
          attempts: number;
          last_error: string;
          lease_token: string | null;
        }>('SELECT * FROM commerce_reconciliation_jobs WHERE order_id=$1', [
          orderId,
        ]);
        assert.equal(job!.attempts, 2);
        provider.fail = false;
        await features.configure(admin, 'payments', {
          enabled: false,
          version: 2,
        });
        const before = provider.lookupCount;
        await worker.tick();
        assert.equal(provider.lookupCount, before);
        await features.configure(admin, 'payments', {
          enabled: true,
          version: 3,
        });
        provider.snapshots.set(paymentId, {
          providerId: paymentId,
          state: 'captured',
          amountMinor: 9900,
          currency: 'RUB',
        });
      },
    );
    await t.test(
      'reconciliation leases fence slow workers, failures become DLQ and retry is audited',
      async () => {
        await pool.query(
          'UPDATE commerce_reconciliation_jobs SET available_at=now(),attempts=7',
        );
        provider.fail = true;
        await worker.tick();
        provider.fail = false;
        const [dead] = await db.rows<{ dead_at: Date; attempts: number }>(
          'SELECT dead_at,attempts FROM commerce_reconciliation_jobs WHERE order_id=$1',
          [orderId],
        );
        assert.ok(dead!.dead_at);
        assert.equal(dead!.attempts, 8);
        assert.equal(
          (
            await call(
              '/reconciliation/' + orderId + '/retry',
              'POST',
              undefined,
              secrets[2],
              'retry-job-001',
            )
          ).status,
          403,
        );
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await call(
                '/reconciliation/' + orderId + '/retry',
                'POST',
                undefined,
                secrets[1],
                'retry-job-001',
              )
            ).status,
            201,
          );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM audit_events WHERE action='commerce.reconciliation.retry'",
            )
          ).rows[0].count,
          '1',
        );
        let started!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          started = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        provider.hold = async () => {
          started();
          await held;
        };
        provider.snapshots.set(paymentId, {
          providerId: paymentId,
          state: 'refunded',
          amountMinor: 9900,
          currency: 'RUB',
        });
        const running = worker.tick();
        await waiting;
        await pool.query(
          "UPDATE commerce_reconciliation_jobs SET lease_token=$1,lease_until=now()+interval '1 minute' WHERE order_id=$2",
          [randomUUID(), orderId],
        );
        release();
        await running;
        provider.hold = undefined;
        assert.equal(
          (
            await pool.query(
              'SELECT state FROM commerce_payment_orders WHERE id=$1',
              [orderId],
            )
          ).rows[0].state,
          'captured',
        );
        provider.snapshots.set(paymentId, {
          providerId: paymentId,
          state: 'captured',
          amountMinor: 9900,
          currency: 'RUB',
        });
        await pool.query(
          'UPDATE commerce_reconciliation_jobs SET lease_token=NULL,lease_until=NULL,available_at=now()',
        );
      },
    );
    await t.test(
      'webhook authenticates original raw bytes without user session; replay payload conflicts fail',
      async () => {
        const payload = Buffer.from(
          JSON.stringify(
            {
              orderId,
              eventKey: 'webhook-capture-001',
              ...provider.snapshots.get(paymentId),
            },
            null,
            2,
          ),
        );
        const signature = createHmac('sha256', provider.secret)
          .update(payload)
          .digest('hex');
        for (let i = 0; i < 2; i++) {
          const res = await fetch(base + '/v1/commerce/webhook', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-payment-signature': signature,
            },
            body: payload,
          });
          assert.equal(res.status, 201);
          const data = (await res.json()) as { replayed: boolean };
          assert.equal(data.replayed, i === 1);
        }
        const invalid = await fetch(base + '/v1/commerce/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-payment-signature': signature,
          },
          body: '{}',
        });
        assert.equal(invalid.status, 400);
        await assert.rejects(
          commerce.applyPaymentEvent(
            orderId,
            'webhook-capture-001',
            'refunded',
            'webhook',
            {},
          ),
          /reused/,
        );
        await assert.rejects(
          commerce.applyPaymentEvent(
            orderId,
            'event-backward-001',
            'pending',
            'test',
            {},
          ),
          /Invalid payment transition/,
        );
        await assert.rejects(
          pool.query('DELETE FROM commerce_payment_events'),
          /append-only/,
        );
      },
    );
    await t.test(
      'paid activation enforces listing access, captured amount, idempotency and one-use payment',
      async () => {
        const product = await commerce.createPromotion(
          admin,
          {
            code: 'vip_24h',
            kind: 'vip',
            priceMinor: 9900,
            currency: 'RUB',
            durationHours: 24,
            priority: 50,
            enabled: true,
            version: 1,
          },
          'product-key-001',
        );
        assert.equal(product.code, 'vip_24h');
        const body = {
          listingId,
          code: 'vip_24h',
          version: 1,
          paymentOrderId: orderId,
        };
        const activation = await commerce.activatePromotion(
          owner,
          body,
          'activation-key-001',
        );
        activationId = String(activation.id);
        assert.equal(
          (await commerce.activatePromotion(owner, body, 'activation-key-001'))
            .id,
          activation.id,
        );
        await assert.rejects(
          commerce.activatePromotion(
            owner,
            { ...body, listingId: otherListingId },
            'activation-key-other',
          ),
          /Forbidden/,
        );
        await assert.rejects(
          commerce.activatePromotion(
            owner,
            { listingId, code: 'vip_24h', version: 1 },
            'activation-without-pay',
          ),
          /Captured payment/,
        );
        await assert.rejects(
          commerce.activatePromotion(owner, body, 'activation-key-002'),
          /duplicate key/,
        );
        await commerce.configureProduct(
          admin,
          'vip_24h',
          1,
          { enabled: false },
          'disable-sku-001',
        );
        assert.equal(
          (await paid.signals([listingId])).length,
          1,
          'Existing paid entitlement survives catalog withdrawal',
        );
        await assert.rejects(
          commerce.activatePromotion(owner, body, 'withdrawn-sku-001'),
          /unavailable/,
        );
        assert.equal((await paid.signals([listingId])).length, 1);
        await pool.query("UPDATE listings SET status='paused' WHERE id=$1", [
          listingId,
        ]);
        await pool.query("UPDATE listings SET status='published' WHERE id=$1", [
          listingId,
        ]);
      },
    );
    await t.test(
      'scheduled promotion expiry/start has a worker path and preserves organic order',
      async () => {
        await pool.query(
          "UPDATE commerce_promotion_activations SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE id=$1",
          [activationId],
        );
        await worker.tick();
        assert.equal((await paid.signals([listingId])).length, 0);
        assert.equal(
          (
            await pool.query(
              'SELECT status FROM commerce_promotion_activations WHERE id=$1',
              [activationId],
            )
          ).rows[0].status,
          'expired',
        );
        const organic = [{ id: otherListingId }, { id: listingId }];
        assert.deepEqual(
          paid
            .attach(organic, [
              {
                listingId,
                code: 'vip_24h',
                kind: 'vip',
                priority: 999,
                endsAt: new Date(Date.now() + 3600000).toISOString(),
              },
            ])
            .map((r) => r.id),
          organic.map((r) => r.id),
        );
      },
    );
    await t.test(
      'worker starts scheduled promotions and cancellation replays without duplicate audit',
      async () => {
        await commerce.createPromotion(
          admin,
          {
            code: 'free_24h',
            kind: 'standard',
            priceMinor: 0,
            currency: 'RUB',
            durationHours: 24,
            priority: 0,
            enabled: true,
            version: 1,
          },
          'free-product-001',
        );
        const scheduled = await commerce.activatePromotion(
          owner,
          {
            listingId,
            code: 'free_24h',
            version: 1,
            startsAt: new Date(Date.now() + 3600000).toISOString(),
          },
          'free-activation-001',
        );
        assert.equal(scheduled.status, 'scheduled');
        await pool.query(
          "UPDATE commerce_promotion_activations SET starts_at=now()-interval '1 minute' WHERE id=$1",
          [scheduled.id],
        );
        await worker.tick();
        assert.equal(
          (
            await pool.query(
              'SELECT status FROM commerce_promotion_activations WHERE id=$1',
              [scheduled.id],
            )
          ).rows[0].status,
          'active',
        );
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await call(
                '/promotions/activations/' + String(scheduled.id) + '/cancel',
                'POST',
                undefined,
                secrets[0],
              )
            ).status,
            201,
          );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM audit_events WHERE action='commerce.promotion.cancelled' AND entity_id=$1",
              [scheduled.id],
            )
          ).rows[0].count,
          '1',
        );
      },
    );
    await t.test(
      'legacy transaction-wrapped migration failure rolls back schema and checksum together',
      async () => {
        const directory = resolve(
          process.env.LOCAL_PRIVATE_DIR!,
          'wrapped-migration',
        );
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, '005_atomic_failure.sql'),
          'BEGIN; CREATE TABLE commerce_must_rollback(id int); SELECT nonexistent_column; COMMIT;',
        );
        await assert.rejects(migrate(pool, directory), /does not exist/);
        assert.equal(
          (
            await pool.query(
              "SELECT to_regclass('commerce_must_rollback') name",
            )
          ).rows[0].name,
          null,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM schema_migrations WHERE name='005_atomic_failure.sql'",
            )
          ).rows[0].count,
          '0',
        );
      },
    );
    await t.test(
      'advertising counters and spend are idempotent under concurrent events',
      async () => {
        assert.equal(
          (
            await call(
              '/ads/placements',
              'POST',
              { code: 'sidebar' },
              secrets[2],
              'ad-placement-buyer',
            )
          ).status,
          403,
        );
        await commerce.createPlacement(
          admin,
          { code: 'sidebar', enabled: true },
          'ad-placement-001',
        );
        const campaign = await commerce.createCampaign(
          admin,
          {
            placementCode: 'sidebar',
            name: 'Campaign',
            startsAt: new Date(Date.now() - 60000).toISOString(),
            endsAt: new Date(Date.now() + 3600000).toISOString(),
            budgetMinor: 10,
            impressionCostMinor: 2,
            clickCostMinor: 3,
            status: 'active',
          },
          'ad-campaign-001',
        );
        campaignId = String(campaign.id);
        const event = { eventId: randomUUID(), kind: 'impression' };
        const results = await Promise.all([
          commerce.recordAdvertising(
            admin,
            campaignId,
            event,
            'ad-impression-001',
          ),
          commerce.recordAdvertising(
            admin,
            campaignId,
            event,
            'ad-impression-001',
          ),
          commerce.recordAdvertising(
            admin,
            campaignId,
            event,
            'ad-impression-new-key',
          ),
        ]);
        assert.equal(results.filter((r) => r.replayed === false).length, 2);
        await assert.rejects(
          commerce.recordAdvertising(
            admin,
            campaignId,
            { ...event, kind: 'click' },
            'ad-click-conflict',
          ),
          /payload changed/,
        );
        await commerce.recordAdvertising(
          admin,
          campaignId,
          { eventId: randomUUID(), kind: 'click' },
          'ad-click-001',
        );
        const [stored] = await db.rows<{
          impressions: string;
          clicks: string;
          spent_minor: string;
        }>('SELECT * FROM advertising_campaigns WHERE id=$1', [campaignId]);
        assert.equal(stored!.impressions, '1');
        assert.equal(stored!.clicks, '1');
        assert.equal(stored!.spent_minor, '5');
        const attempts = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            commerce.recordAdvertising(
              admin,
              campaignId,
              { eventId: randomUUID(), kind: 'click' },
              'budget-click-' + i,
            ),
          ),
        );
        assert.equal(
          attempts.filter((r) => r.status === 'fulfilled').length,
          1,
        );
        const [budget] = await db.rows<{ spent_minor: string }>(
          'SELECT spent_minor FROM advertising_campaigns WHERE id=$1',
          [campaignId],
        );
        assert.equal(budget!.spent_minor, '8');
        await assert.rejects(
          pool.query('DELETE FROM advertising_events'),
          /append-only/,
        );
      },
    );
    await t.test(
      'campaign dates, targeting and feature kill switch block serving/counter writes',
      async () => {
        await assert.rejects(
          commerce.createCampaign(
            admin,
            {
              placementCode: 'sidebar',
              name: 'Bad category',
              startsAt: new Date(Date.now() - 60000).toISOString(),
              endsAt: new Date(Date.now() + 3600000).toISOString(),
              categoryTarget: { categories: ['unknown'] },
              status: 'draft',
            },
            'bad-category-001',
          ),
          /Unknown advertising category/,
        );
        await pool.query(
          "UPDATE advertising_campaigns SET status='paused' WHERE id=$1",
          [campaignId],
        );
        await assert.rejects(
          commerce.recordAdvertising(
            admin,
            campaignId,
            { eventId: randomUUID(), kind: 'impression' },
            'paused-event-001',
          ),
          /not serving/,
        );
        await features.configure(admin, 'advertising', {
          enabled: false,
          version: 2,
        });
        assert.deepEqual(await commerce.activeCampaigns('sidebar'), []);
        await assert.rejects(
          commerce.recordAdvertising(
            admin,
            campaignId,
            { eventId: randomUUID(), kind: 'click' },
            'disabled-event-001',
          ),
          /disabled/,
        );
        assert.ok(
          (
            await db.rows(
              "SELECT id FROM audit_events WHERE action='commerce.ad.click'",
            )
          ).length >= 2,
        );
      },
    );
    await t.test(
      'Payment failure alerts include late transitions and exclude historical same-state events',
      async () => {
        const operations = app.get(Operations);
        const before = (await operations.snapshot()).failures.payments;
        const order = await commerce.createOrder(
          owner,
          'operations-late-failure-001',
          orderBody,
        );
        const id = String(order.id);
        await commerce.startPayment(owner, id);
        await pool.query(
          "UPDATE commerce_payment_orders SET created_at=now()-interval '2 hours' WHERE id=$1",
          [id],
        );
        await commerce.applyPaymentEvent(
          id,
          'rc-late-failure-001',
          'failed',
          'rc',
          {},
        );
        assert.equal(
          (await operations.snapshot()).failures.payments,
          before + 1,
        );
        await commerce.applyPaymentEvent(
          id,
          'rc-late-failure-001',
          'failed',
          'rc',
          {},
        );
        await commerce.applyPaymentEvent(
          id,
          'rc-same-failure-001',
          'failed',
          'rc',
          {},
        );
        assert.equal(
          (await operations.snapshot()).failures.payments,
          before + 1,
        );
        const historical = await commerce.createOrder(
          owner,
          'operations-historical-failure-001',
          orderBody,
        );
        const historicalId = String(historical.id);
        await commerce.startPayment(owner, historicalId);
        await pool.query(
          "UPDATE commerce_payment_orders SET created_at=now()-interval '2 hours',state='failed' WHERE id=$1",
          [historicalId],
        );
        await pool.query(
          "INSERT INTO commerce_payment_events(payment_order_id,from_state,to_state,source,event_key,created_at) VALUES($1,'pending','failed','rc','rc-historical-failure-001',now()-interval '2 hours')",
          [historicalId],
        );
        await commerce.applyPaymentEvent(
          historicalId,
          'rc-historical-noop-001',
          'failed',
          'rc',
          {},
        );
        assert.equal(
          (await operations.snapshot()).failures.payments,
          before + 1,
        );
      },
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
