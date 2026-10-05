import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { Database } from './modules/database/database';
import { migrate } from './modules/database/migrate';
import {
  CommerceService,
  PaymentProvider,
  ProviderPayment,
  PaymentState,
} from './modules/commerce/commerce';

class TestPaymentProvider extends PaymentProvider {
  event: { orderId: string; eventKey: string; state: PaymentState } | null =
    null;

  async createPayment(): Promise<ProviderPayment> {
    return { providerId: 'test-provider', state: 'pending' };
  }

  async refundPayment(): Promise<ProviderPayment> {
    return { providerId: 'test-provider', state: 'refunded' };
  }

  async verifyWebhook(signature: string): Promise<boolean> {
    return signature === 'valid-signature';
  }

  async parseWebhook(): Promise<{
    orderId: string;
    eventKey: string;
    state: PaymentState;
  }> {
    if (!this.event) throw new Error('Test event not configured');
    return this.event;
  }
}

test('Phase 4A commerce PostgreSQL acceptance', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL?.includes('/raui_test_'));
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await migrate(pool);

  const provider = new TestPaymentProvider();
  const module = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PaymentProvider)
    .useValue(provider)
    .compile();

  const db = module.get(Database);
  const commerce = module.get(CommerceService);
  const actor = {
    id: randomUUID(),
    role: 'owner' as const,
    email_verified_at: new Date().toISOString(),
    phone_verified_at: new Date().toISOString(),
    session_id: randomUUID(),
  };

  try {
    await t.test('payment creation is idempotent by account and key', async () => {
      const input = {
        amountMinor: 15000,
        currency: 'RUB',
        reference: 'listing-promotion',
        provider: 'test',
      };
      const first = await commerce.createOrder(actor, 'commerce-order-001', input);
      const second = await commerce.createOrder(actor, 'commerce-order-001', input);
      assert.equal(second.id, first.id);
      assert.equal(first.state, 'created');

      await assert.rejects(
        commerce.createOrder(actor, 'commerce-order-001', {
          ...input,
          amountMinor: 16000,
        }),
        /Idempotency key reused/,
      );
    });

    await t.test('payment events are replay-safe and state constrained', async () => {
      const [order] = await db.rows<{ id: string }>(
        'SELECT id FROM commerce_payment_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
        [actor.id],
      );
      assert.ok(order);

      const pending = await commerce.applyPaymentEvent(
        order.id,
        'event:pending:001',
        'pending',
        'test',
        { provider: 'test' },
      );
      assert.deepEqual(pending, { replayed: false, state: 'pending' });

      const replay = await commerce.applyPaymentEvent(
        order.id,
        'event:pending:001',
        'pending',
        'test',
        { provider: 'test' },
      );
      assert.deepEqual(replay, { replayed: true });

      await commerce.applyPaymentEvent(
        order.id,
        'event:captured:001',
        'captured',
        'test',
        { provider: 'test' },
      );

      await assert.rejects(
        commerce.applyPaymentEvent(
          order.id,
          'event:pending:002',
          'pending',
          'test',
          {},
        ),
        /Invalid payment transition/,
      );
    });

    await t.test('verified webhook feeds the same replay-safe transition path', async () => {
      const [order] = await db.rows<{ id: string; state: PaymentState }>(
        'SELECT id,state FROM commerce_payment_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
        [actor.id],
      );
      assert.ok(order);

      const [fresh] = await db.rows<{ id: string }>(
        `INSERT INTO commerce_payment_orders(
          account_id,provider,reference,idempotency_key,amount_minor,currency,state
        ) VALUES($1,'test','webhook-test','commerce-webhook-001',1000,'RUB','created')
        RETURNING id`,
        [actor.id],
      );
      provider.event = {
        orderId: fresh.id,
        eventKey: 'webhook:event:001',
        state: 'pending',
      };

      await assert.rejects(
        commerce.webhook('invalid-signature', Buffer.from('{}')),
        /Invalid webhook signature/,
      );
      const accepted = await commerce.webhook(
        'valid-signature',
        Buffer.from('{}'),
      );
      assert.deepEqual(accepted, { replayed: false, state: 'pending' });
      const replay = await commerce.webhook(
        'valid-signature',
        Buffer.from('{}'),
      );
      assert.deepEqual(replay, { replayed: true });
    });

    await t.test('promotion activation requires enabled product and captured payment', async () => {
      const product = await commerce.createPromotion({
        code: 'vip_24h',
        kind: 'vip',
        priceMinor: 9900,
        currency: 'RUB',
        durationHours: 24,
        priority: 50,
        enabled: true,
        version: 1,
      });
      assert.equal(product.code, 'vip_24h');

      const [payment] = await db.rows<{ id: string }>(
        `INSERT INTO commerce_payment_orders(
          account_id,provider,reference,idempotency_key,amount_minor,currency,state
        ) VALUES($1,'test','promo','commerce-promo-001',9900,'RUB','captured')
        RETURNING id`,
        [actor.id],
      );

      const activation = await commerce.activatePromotion(actor, {
        listingId: randomUUID(),
        code: 'vip_24h',
        version: 1,
        paymentOrderId: payment.id,
        startsAt: '2026-10-05T10:00:00.000Z',
      });
      assert.equal(activation.payment_order_id, payment.id);
      assert.equal(activation.status, 'active');

      const [uncaptured] = await db.rows<{ id: string }>(
        `INSERT INTO commerce_payment_orders(
          account_id,provider,reference,idempotency_key,amount_minor,currency,state
        ) VALUES($1,'test','promo','commerce-promo-002',9900,'RUB','pending')
        RETURNING id`,
        [actor.id],
      );
      await assert.rejects(
        commerce.activatePromotion(actor, {
          listingId: randomUUID(),
          code: 'vip_24h',
          version: 1,
          paymentOrderId: uncaptured.id,
        }),
        /Captured payment required/,
      );
    });
  } finally {
    await module.close();
    await pool.end();
  }
});
