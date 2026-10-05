import { PaidPlacementModule, PromotionKind } from './placements';
export {
  PaidPlacementService,
  attachPaidPlacementSignals,
  paidPlacementProjection,
  PaidPlacementSignal,
  PromotionKind,
} from './placements';
import { paymentDeadline } from './timeout';
import { PaymentReconciliation } from './reconciliation';
import { isDeepStrictEqual } from 'node:util';
import { CommerceFeatures, CommerceFeaturesModule } from './features';
import { Audit, AuditModule } from '../audit/audit';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { normalizeIdempotencyKey } from './keys';
export { normalizeIdempotencyKey } from './keys';
import { Public, seller, verified, uuid, hash } from '../../common/security';
import type { Request } from 'express';
import { AdminOnly, Actor, CurrentActor, parse } from '../../common/security';
import { Database } from '../database/database';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

export const paymentStates = [
  'created',
  'pending',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type PaymentState = (typeof paymentStates)[number];

const transitions: Record<PaymentState, readonly PaymentState[]> = {
  created: ['pending', 'cancelled'],
  pending: ['authorized', 'captured', 'failed', 'cancelled'],
  authorized: ['captured', 'cancelled'],
  captured: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};

export function assertPaymentTransition(
  from: PaymentState,
  to: PaymentState,
): void {
  if (!transitions[from].includes(to))
    throw new ConflictException(`Invalid payment transition: ${from} -> ${to}`);
}

export function normalizePaymentEventKey(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Payment event key is required');
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key))
    throw new BadRequestException('Invalid payment event key');
  return key;
}

export type PromotionActivationState =
  'scheduled' | 'active' | 'expired' | 'cancelled';

export function assertPromotionActivationTransition(
  from: PromotionActivationState,
  to: PromotionActivationState,
): void {
  const allowed: Record<
    PromotionActivationState,
    readonly PromotionActivationState[]
  > = {
    scheduled: ['active', 'cancelled'],
    active: ['expired', 'cancelled'],
    expired: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to))
    throw new ConflictException(
      `Invalid promotion transition: ${from} -> ${to}`,
    );
}

export function promotionWindow(
  startsAt: string | undefined,
  durationHours: number,
): { startsAt: string; endsAt: string } {
  if (
    !Number.isInteger(durationHours) ||
    durationHours < 1 ||
    durationHours > 8760
  )
    throw new BadRequestException('Invalid promotion duration');
  const start = startsAt ? new Date(startsAt) : new Date();
  if (Number.isNaN(start.getTime()))
    throw new BadRequestException('Invalid promotion start time');
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(
      start.getTime() + durationHours * 60 * 60 * 1000,
    ).toISOString(),
  };
}

export interface PromotionProduct {
  code: string;
  kind: PromotionKind;
  priceMinor: number;
  currency: string;
  durationHours: number;
  priority: number;
  enabled: boolean;
  version: number;
}

export function validatePromotionProduct(
  product: PromotionProduct,
): PromotionProduct {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(product.code))
    throw new BadRequestException('Invalid promotion code');
  if (!Number.isSafeInteger(product.priceMinor) || product.priceMinor < 0)
    throw new BadRequestException('Invalid promotion price');
  if (!/^[A-Z]{3}$/.test(product.currency))
    throw new BadRequestException('Invalid currency');
  if (
    !Number.isInteger(product.durationHours) ||
    product.durationHours < 1 ||
    product.durationHours > 8760
  )
    throw new BadRequestException('Invalid promotion duration');
  if (
    !Number.isInteger(product.priority) ||
    product.priority < 0 ||
    product.priority > 2147483647
  )
    throw new BadRequestException('Invalid promotion priority');
  if (
    !Number.isInteger(product.version) ||
    product.version < 1 ||
    product.version > 2147483647
  )
    throw new BadRequestException('Invalid promotion version');
  return product;
}

export interface CreatePaymentInput {
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reference: string;
}

export interface ProviderPayment {
  providerId: string;
  state: PaymentState;
}

export const providerSnapshotSchema = z
  .object({
    providerId: z.string().min(1).max(200),
    state: z.enum(paymentStates),
    amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type ProviderSnapshot = z.infer<typeof providerSnapshotSchema>;
export const providerWebhookSchema = providerSnapshotSchema
  .extend({ orderId: z.uuid(), eventKey: z.string().min(8).max(160) })
  .strict();
export type ProviderWebhook = z.infer<typeof providerWebhookSchema>;
export abstract class PaymentProvider {
  readonly name: string = 'unconfigured';
  readonly configured: boolean = false;
  async lookupPayment(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ProviderSnapshot> {
    void providerId;
    void signal;
    throw new ServiceUnavailableException(
      'Payment reconciliation provider is not configured',
    );
  }
  abstract createPayment(
    input: CreatePaymentInput,
    signal: AbortSignal,
  ): Promise<ProviderPayment>;
  abstract refundPayment(
    providerId: string,
    amountMinor?: number,
  ): Promise<ProviderPayment>;
  abstract verifyWebhook(signature: string, payload: Buffer): Promise<boolean>;
  abstract parseWebhook(payload: Buffer): Promise<ProviderWebhook>;
}

@Injectable()
export class UnconfiguredPaymentProvider extends PaymentProvider {
  async createPayment(): Promise<ProviderPayment> {
    throw new BadRequestException('Payment provider is not configured');
  }
  async refundPayment(): Promise<ProviderPayment> {
    throw new BadRequestException('Payment provider is not configured');
  }
  async verifyWebhook(): Promise<boolean> {
    return false;
  }
  async parseWebhook(): Promise<never> {
    throw new BadRequestException('Payment provider is not configured');
  }
}

export const orderInput = z
  .object({
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().trim().min(1).max(200),
    provider: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{2,40}$/),
  })
  .strict();

export const advertisingEventInput = z
  .object({ eventId: z.uuid(), kind: z.enum(['impression', 'click']) })
  .strict();
export const placementInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{2,64}$/),
    description: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(false),
  })
  .strict();

export const campaignInput = z
  .object({
    placementCode: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{2,64}$/),
    organizationId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    budgetMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    impressionCostMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    clickCostMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    geoTarget: z
      .object({
        locality: z.string().min(1).max(150).optional(),
        district: z.string().min(1).max(150).optional(),
      })
      .strict()
      .default({}),
    categoryTarget: z
      .object({
        categories: z.array(z.string().min(1).max(50)).max(30).default([]),
      })
      .strict()
      .default({ categories: [] }),
    creativeMetadata: z
      .object({
        title: z.string().max(150).optional(),
        description: z.string().max(500).optional(),
        url: z
          .url()
          .refine((v) => new URL(v).protocol === 'https:')
          .optional(),
        mediaId: z.uuid().optional(),
      })
      .strict()
      .default({}),
    status: z.enum(['draft', 'scheduled', 'active', 'paused', 'ended']),
  })
  .strict();

export const promotionInput = z
  .object({
    code: z.string(),
    kind: z.enum([
      'standard',
      'highlighted',
      'premium',
      'vip',
      'super_vip',
      'top',
    ]),
    priceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    durationHours: z.number().int().min(1).max(8760),
    priority: z.number().int().nonnegative().max(2147483647),
    enabled: z.boolean(),
    version: z.number().int().min(1).max(2147483647),
  })
  .strict();

@Injectable()
export class CommercePolicy {
  readonly riskyFeaturesDefaultOff = {
    payments: true,
    promotions: true,
    advertising: true,
  } as const;

  promotion(product: PromotionProduct): PromotionProduct {
    return validatePromotionProduct(product);
  }

  idempotencyKey(value: unknown): string {
    return normalizeIdempotencyKey(value);
  }

  transition(from: PaymentState, to: PaymentState): void {
    assertPaymentTransition(from, to);
  }
}

@Injectable()
export class CommerceService {
  constructor(
    private readonly db: Database,
    private readonly policy: CommercePolicy,
    readonly paymentProvider: PaymentProvider,
    readonly features: CommerceFeatures,
    readonly audit: Audit,
    readonly access: ListingAccess,
  ) {}

  async createOrder(actor: Actor, key: unknown, body: unknown) {
    await this.features.require('payments');
    const input = parse(orderInput, body);
    if (
      !this.paymentProvider.configured ||
      input.provider !== this.paymentProvider.name
    )
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    const idempotencyKey = this.policy.idempotencyKey(key);

    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${actor.id}:commerce:${idempotencyKey}`,
      ]);
      const [existing] = await this.db.rows(
        'SELECT id,account_id,provider,reference,idempotency_key,amount_minor,currency,state,created_at,updated_at FROM commerce_payment_orders WHERE account_id=$1 AND idempotency_key=$2',
        [actor.id, idempotencyKey],
        sql,
      );
      if (existing) {
        const same =
          existing.provider === input.provider &&
          existing.reference === input.reference &&
          Number(existing.amount_minor) === input.amountMinor &&
          existing.currency === input.currency;
        if (!same)
          throw new ConflictException(
            'Idempotency key reused with another payment payload',
          );
        return existing;
      }

      const [created] = await this.db.rows(
        `INSERT INTO commerce_payment_orders(
          account_id,provider,reference,idempotency_key,amount_minor,currency,state
        ) VALUES($1,$2,$3,$4,$5,$6,'created')
        RETURNING id,account_id,provider,reference,idempotency_key,amount_minor,currency,state,created_at,updated_at`,
        [
          actor.id,
          input.provider,
          input.reference,
          idempotencyKey,
          input.amountMinor,
          input.currency,
        ],
        sql,
      );
      await sql.query(
        `INSERT INTO commerce_payment_events(
          payment_order_id,from_state,to_state,source,event_key,payload
        ) VALUES($1,NULL,'created','api',$2,$3)`,
        [created!.id, `create:${idempotencyKey}`, JSON.stringify(input)],
      );
      await this.audit.record(
        sql,
        actor.id,
        'commerce.order.created',
        'payment_order',
        String(created!.id),
        { amountMinor: input.amountMinor, currency: input.currency },
      );
      return created!;
    });
  }

  async applyPaymentEvent(
    orderId: string,
    eventKey: string,
    toState: PaymentState,
    source: string,
    payload: unknown,
  ) {
    parse(uuid, orderId);
    parse(z.enum(paymentStates), toState);
    eventKey = normalizePaymentEventKey(eventKey);
    if (!/^[a-z0-9_-]{2,40}$/.test(source))
      throw new BadRequestException('Invalid payment event source');

    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `commerce-payment:${orderId}`,
      ]);
      const [replayed] = await this.db.rows(
        'SELECT id,to_state,source,payload FROM commerce_payment_events WHERE payment_order_id=$1 AND event_key=$2',
        [orderId, eventKey],
        sql,
      );
      if (replayed) {
        if (
          replayed.to_state !== toState ||
          replayed.source !== source ||
          !isDeepStrictEqual(replayed.payload, payload ?? {})
        )
          throw new ConflictException(
            'Payment event key reused with another payload',
          );
        return { replayed: true };
      }

      const [order] = await this.db.rows<{ state: PaymentState }>(
        'SELECT state FROM commerce_payment_orders WHERE id=$1 FOR UPDATE',
        [orderId],
        sql,
      );
      if (!order) throw new BadRequestException('Unknown payment order');

      if (order.state !== toState) this.policy.transition(order.state, toState);
      await sql.query(
        'UPDATE commerce_payment_orders SET state=$2,updated_at=now() WHERE id=$1',
        [orderId, toState],
      );
      await sql.query(
        `INSERT INTO commerce_payment_events(
          payment_order_id,from_state,to_state,source,event_key,payload
        ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          orderId,
          order.state,
          toState,
          source,
          eventKey,
          JSON.stringify(payload ?? {}),
        ],
      );
      if (toState === 'refunded')
        await sql.query(
          "UPDATE commerce_promotion_activations SET status='cancelled' WHERE payment_order_id=$1 AND status IN ('active','scheduled')",
          [orderId],
        );
      await this.audit.record(
        sql,
        null,
        'commerce.payment.' + toState,
        'payment_order',
        orderId,
        { eventKey, source },
      );
      return { replayed: false, state: toState };
    });
  }

  async orders(actor: Actor) {
    return this.db.rows(
      `SELECT id,provider,reference,amount_minor,currency,state,created_at,updated_at
       FROM commerce_payment_orders
       WHERE account_id=$1
       ORDER BY created_at DESC,id DESC
       LIMIT 100`,
      [actor.id],
    );
  }

  async promotions() {
    return this.db.rows(
      `SELECT code,kind,version,price_minor,currency,duration_hours,priority,enabled
       FROM commerce_promotion_products
       WHERE enabled
       ORDER BY priority DESC,code,version DESC`,
    );
  }

  async activatePromotion(actor: Actor, body: unknown, key: unknown) {
    seller(actor);
    await this.features.require('promotions');
    const input = parse(
      z
        .object({
          listingId: z.uuid(),
          code: z.string().min(2).max(64),
          version: z.number().int().positive(),
          paymentOrderId: z.uuid().optional(),
          startsAt: z.iso.datetime().optional(),
        })
        .strict(),
      body,
    );

    await this.access.get(actor, input.listingId);
    return this.features.idempotent(
      actor,
      'commerce.activate',
      key,
      input,
      async (sql) => {
        await this.features.require('promotions', sql);
        await this.access.get(actor, input.listingId, sql, true);
        const [product] = await this.db.rows<{
          id: string;
          duration_hours: number;
          enabled: boolean;
          price_minor: string;
          currency: string;
        }>(
          `SELECT id,duration_hours,enabled,price_minor,currency
         FROM commerce_promotion_products
         WHERE code=$1 AND version=$2`,
          [input.code, input.version],
          sql,
        );
        if (!product || !product.enabled)
          throw new BadRequestException('Promotion product unavailable');

        if (Number(product.price_minor) > 0 && !input.paymentOrderId)
          throw new ConflictException('Captured payment required');
        if (input.paymentOrderId) {
          const [payment] = await this.db.rows<{
            state: PaymentState;
            amount_minor: string;
            currency: string;
          }>(
            `SELECT state,amount_minor,currency
           FROM commerce_payment_orders
           WHERE id=$1 AND account_id=$2 FOR UPDATE`,
            [input.paymentOrderId, actor.id],
            sql,
          );
          if (
            !payment ||
            payment.state !== 'captured' ||
            Number(payment.amount_minor) !== Number(product.price_minor) ||
            payment.currency !== product.currency
          )
            throw new ConflictException('Captured payment required');
        }

        const window = promotionWindow(input.startsAt, product.duration_hours);
        const [activation] = await this.db.rows(
          `INSERT INTO commerce_promotion_activations(
          account_id,listing_id,promotion_product_id,payment_order_id,
          starts_at,ends_at,status
        ) VALUES(
          $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,
          CASE WHEN $5::timestamptz>clock_timestamp() THEN 'scheduled' ELSE 'active' END
        )
        RETURNING id,listing_id,payment_order_id,starts_at,ends_at,status`,
          [
            actor.id,
            input.listingId,
            product.id,
            input.paymentOrderId ?? null,
            window.startsAt,
            window.endsAt,
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'commerce.promotion.activated',
          'promotion_activation',
          String(activation!.id),
          { listingId: input.listingId, productId: product.id },
        );
        return activation!;
      },
    );
  }

  async webhook(signature: unknown, payload: Buffer) {
    if (typeof signature !== 'string' || !signature.trim())
      throw new BadRequestException('Webhook signature is required');
    if (!(await this.paymentProvider.verifyWebhook(signature, payload)))
      throw new BadRequestException('Invalid webhook signature');
    const event = parse(
      providerWebhookSchema,
      await this.paymentProvider.parseWebhook(payload),
    );
    const [order] = await this.db.rows<{
      provider: string;
      provider_payment_id: string | null;
      amount_minor: string;
      currency: string;
    }>(
      'SELECT provider,provider_payment_id,amount_minor,currency FROM commerce_payment_orders WHERE id=$1',
      [event.orderId],
    );
    if (
      !order ||
      order.provider !== this.paymentProvider.name ||
      order.provider_payment_id !== event.providerId ||
      Number(order.amount_minor) !== event.amountMinor ||
      order.currency !== event.currency
    )
      throw new ConflictException('Webhook does not match order');
    return this.applyPaymentEvent(
      event.orderId,
      event.eventKey,
      event.state,
      'webhook',
      {
        providerEvent: event.eventKey,
        payloadHash: hash(JSON.stringify(event)),
      },
    );
  }

  async transitionActivation(
    actor: Actor,
    activationId: string,
    toState: PromotionActivationState,
  ) {
    parse(uuid, activationId);
    if (actor.role === 'admin') verified(actor);
    return this.db.transaction(async (sql) => {
      const [activation] = await this.db.rows<{
        status: PromotionActivationState;
      }>(
        `SELECT status
         FROM commerce_promotion_activations
         WHERE id=$1 AND (account_id=$2 OR $3::boolean)
         FOR UPDATE`,
        [activationId, actor.id, actor.role === 'admin'],
        sql,
      );
      if (!activation)
        throw new BadRequestException('Unknown promotion activation');
      if (activation.status === toState)
        return (
          await this.db.rows(
            'SELECT id,listing_id,payment_order_id,starts_at,ends_at,status FROM commerce_promotion_activations WHERE id=$1',
            [activationId],
            sql,
          )
        )[0]!;
      assertPromotionActivationTransition(activation.status, toState);
      const [updated] = await this.db.rows(
        `UPDATE commerce_promotion_activations
         SET status=$3
         WHERE id=$1 AND (account_id=$2 OR $4::boolean)
         RETURNING id,listing_id,payment_order_id,starts_at,ends_at,status`,
        [activationId, actor.id, toState, actor.role === 'admin'],
        sql,
      );
      await this.audit.record(
        sql,
        actor.id,
        'commerce.promotion.' + toState,
        'promotion_activation',
        activationId,
      );
      return updated!;
    });
  }

  async expirePromotions() {
    return this.db.transaction(async (sql) => {
      const expired = await this.db.rows<{ id: string; listing_id: string }>(
        "UPDATE commerce_promotion_activations SET status='expired' WHERE status IN ('active','scheduled') AND ends_at<=now() RETURNING id,listing_id,status",
        [],
        sql,
      );
      const active = await this.db.rows<{ id: string }>(
        "UPDATE commerce_promotion_activations SET status='active' WHERE status='scheduled' AND starts_at<=now() AND ends_at>now() RETURNING id",
        [],
        sql,
      );
      for (const row of expired)
        await this.audit.record(
          sql,
          null,
          'commerce.promotion.expired',
          'promotion_activation',
          row.id,
        );
      for (const row of active)
        await this.audit.record(
          sql,
          null,
          'commerce.promotion.started',
          'promotion_activation',
          row.id,
        );
      return expired;
    });
  }
  async createPlacement(actor: Actor, body: unknown, key: unknown) {
    const input = parse(placementInput, body);
    return this.features.idempotent(
      actor,
      'commerce.placement',
      key,
      input,
      async (sql) => {
        const [row] = await this.db.rows(
          'INSERT INTO advertising_placements(code,description,enabled) VALUES($1,$2,$3) RETURNING *',
          [input.code, input.description, input.enabled],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'commerce.ad.placement.created',
          'ad_placement',
          String(row!.id),
          input,
        );
        return row!;
      },
    );
  }
  async createCampaign(actor: Actor, body: unknown, key: unknown) {
    const input = parse(campaignInput, body);
    if (new Date(input.endsAt) <= new Date(input.startsAt))
      throw new BadRequestException('Campaign end must be after start');
    return this.features.idempotent(
      actor,
      'commerce.campaign',
      key,
      input,
      async (sql) => {
        const categories = await this.db.rows<{ code: string }>(
          'SELECT code FROM categories WHERE code=ANY($1::text[])',
          [input.categoryTarget.categories],
          sql,
        );
        if (categories.length !== new Set(input.categoryTarget.categories).size)
          throw new BadRequestException('Unknown advertising category');
        const [placement] = await this.db.rows<{ id: string }>(
          'SELECT id FROM advertising_placements WHERE code=$1',
          [input.placementCode],
          sql,
        );
        if (!placement) throw new BadRequestException('Unknown ad placement');
        const [row] = await this.db.rows(
          `INSERT INTO advertising_campaigns(organization_id,placement_id,name,starts_at,ends_at,budget_minor,geo_target,category_target,creative_metadata,status,impression_cost_minor,click_cost_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            input.organizationId ?? null,
            placement.id,
            input.name,
            input.startsAt,
            input.endsAt,
            input.budgetMinor ?? null,
            JSON.stringify(input.geoTarget),
            JSON.stringify(input.categoryTarget),
            JSON.stringify(input.creativeMetadata),
            input.status,
            input.impressionCostMinor,
            input.clickCostMinor,
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'commerce.ad.campaign.created',
          'ad_campaign',
          String(row!.id),
          { placementCode: input.placementCode },
        );
        return row!;
      },
    );
  }
  async recordAdvertising(
    actor: Actor,
    campaignId: string,
    body: unknown,
    key: unknown,
  ) {
    parse(uuid, campaignId);
    const input = parse(advertisingEventInput, body);
    await this.features.require('advertising');
    return this.features.idempotent(
      actor,
      'commerce.ad.event:' + campaignId,
      key,
      input,
      async (sql) => {
        await this.features.require('advertising', sql);
        const [campaign] = await this.db.rows<{
          id: string;
          status: string;
          starts_at: Date;
          ends_at: Date;
          budget_minor: string | null;
          spent_minor: string;
          impression_cost_minor: string;
          click_cost_minor: string;
          enabled: boolean;
        }>(
          `SELECT c.*,p.enabled FROM advertising_campaigns c JOIN advertising_placements p ON p.id=c.placement_id WHERE c.id=$1 FOR UPDATE OF c`,
          [campaignId],
          sql,
        );
        if (!campaign) throw new BadRequestException('Unknown ad campaign');
        const [prior] = await this.db.rows<{ kind: string }>(
          'SELECT kind FROM advertising_events WHERE campaign_id=$1 AND event_id=$2',
          [campaignId, input.eventId],
          sql,
        );
        if (prior) {
          if (prior.kind !== input.kind)
            throw new ConflictException('Advertising event payload changed');
          return { replayed: true };
        }
        if (
          !campaign.enabled ||
          campaign.status !== 'active' ||
          campaign.starts_at.getTime() > Date.now() ||
          campaign.ends_at.getTime() <= Date.now()
        )
          throw new ConflictException('Ad campaign is not serving');
        const cost = BigInt(
          input.kind === 'impression'
            ? campaign.impression_cost_minor
            : campaign.click_cost_minor,
        );
        if (
          campaign.budget_minor !== null &&
          BigInt(campaign.spent_minor) + cost > BigInt(campaign.budget_minor)
        )
          throw new ConflictException('Campaign budget exhausted');
        await sql.query(
          'INSERT INTO advertising_events(campaign_id,event_id,kind,cost_minor,actor_id) VALUES($1,$2,$3,$4,$5)',
          [campaignId, input.eventId, input.kind, cost.toString(), actor.id],
        );
        const [updated] = await this.db.rows(
          `UPDATE advertising_campaigns SET impressions=impressions+CASE WHEN $2='impression' THEN 1 ELSE 0 END,clicks=clicks+CASE WHEN $2='click' THEN 1 ELSE 0 END,spent_minor=spent_minor+$3 WHERE id=$1 RETURNING id,impressions,clicks,spent_minor`,
          [campaignId, input.kind, cost.toString()],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'commerce.ad.' + input.kind,
          'ad_campaign',
          campaignId,
          { eventId: input.eventId, costMinor: cost.toString() },
        );
        return { replayed: false, ...updated };
      },
    );
  }
  async activeCampaigns(placementCode: string) {
    if (!(await this.features.enabled('advertising'))) return [];
    return this.db.rows(
      `SELECT c.id,c.name,c.geo_target,c.category_target,c.creative_metadata,
              c.starts_at,c.ends_at,c.budget_minor,c.spent_minor
       FROM advertising_campaigns c
       JOIN advertising_placements p ON p.id=c.placement_id
       WHERE p.code=$1
         AND EXISTS(SELECT 1 FROM public_search_listings s WHERE s.id=a.listing_id)
         AND c.status='active'
         AND c.starts_at<=now()
         AND c.ends_at>now()
         AND (c.budget_minor IS NULL OR c.spent_minor<c.budget_minor)
       ORDER BY c.starts_at,c.id`,
      [placementCode],
    );
  }

  async createPromotion(actor: Actor, body: unknown, key: unknown) {
    const product = this.policy.promotion(parse(promotionInput, body));
    return this.features.idempotent(
      actor,
      'commerce.product',
      key,
      product,
      async (sql) => {
        const [row] = await this.db.rows(
          `INSERT INTO commerce_promotion_products(code,kind,version,price_minor,currency,duration_hours,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            product.code,
            product.kind,
            product.version,
            product.priceMinor,
            product.currency,
            product.durationHours,
            product.priority,
            product.enabled,
          ],
          sql,
        );
        await this.audit.record(
          sql,
          actor.id,
          'commerce.product.created',
          'promotion_product',
          String(row!.id),
          product,
        );
        return row!;
      },
    );
  }
  async configureProduct(
    actor: Actor,
    code: string,
    version: unknown,
    body: unknown,
    key: unknown,
  ) {
    parse(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), code);
    const pricingVersion = parse(
      z.coerce.number().int().positive().max(2147483647),
      version,
    );
    const input = parse(z.object({ enabled: z.boolean() }).strict(), body);
    return this.features.idempotent(
      actor,
      'commerce.product.enabled:' + code + ':' + pricingVersion,
      key,
      input,
      async (sql) => {
        const [row] = await this.db.rows(
          'UPDATE commerce_promotion_products SET enabled=$3 WHERE code=$1 AND version=$2 RETURNING code,version,enabled',
          [code, pricingVersion, input.enabled],
          sql,
        );
        if (!row) throw new BadRequestException('Unknown promotion product');
        await this.audit.record(
          sql,
          actor.id,
          'commerce.product.enabled',
          'promotion_product',
          code + ':' + pricingVersion,
          input,
        );
        return row;
      },
    );
  }
  async reconciliationJobs() {
    return this.db.rows(
      'SELECT order_id,attempts,available_at,checked_at,last_error,dead_at,lease_until FROM commerce_reconciliation_jobs ORDER BY available_at,order_id LIMIT 100',
    );
  }
  async retryReconciliation(actor: Actor, id: string, key: unknown) {
    parse(uuid, id);
    return this.features.idempotent(
      actor,
      'commerce.reconciliation.retry:' + id,
      key,
      { id },
      async (sql) => {
        const [row] = await this.db.rows(
          'UPDATE commerce_reconciliation_jobs SET attempts=0,dead_at=NULL,last_error=NULL,available_at=now() WHERE order_id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING order_id,attempts,dead_at',
          [id],
          sql,
        );
        if (!row) throw new ConflictException('Job missing or leased');
        await this.audit.record(
          sql,
          actor.id,
          'commerce.reconciliation.retry',
          'payment_order',
          id,
        );
        return row;
      },
    );
  }
  async startPayment(actor: Actor, orderId: string) {
    parse(uuid, orderId);
    await this.features.require('payments');
    if (!this.paymentProvider.configured)
      throw new ServiceUnavailableException(
        'Payment provider is not configured',
      );
    const [order] = await this.db.rows<{
      id: string;
      provider: string;
      state: PaymentState;
      amount_minor: string;
      currency: string;
      provider_payment_id: string | null;
    }>('SELECT * FROM commerce_payment_orders WHERE id=$1 AND account_id=$2', [
      orderId,
      actor.id,
    ]);
    if (!order || order.provider !== this.paymentProvider.name)
      throw new BadRequestException('Unknown payment order');
    if (order.provider_payment_id)
      return { providerId: order.provider_payment_id, state: order.state };
    if (order.state !== 'created')
      throw new ConflictException('Payment cannot be started');
    const result = await paymentDeadline((signal) =>
      this.paymentProvider.createPayment(
        {
          amountMinor: Number(order.amount_minor),
          currency: order.currency,
          idempotencyKey: order.id,
          reference: order.id,
        },
        signal,
      ),
    );
    parse(
      z
        .object({
          providerId: z.string().min(1).max(200),
          state: z.enum(paymentStates),
        })
        .strict(),
      result,
    );
    await this.db.transaction(async (sql) => {
      const [locked] = await this.db.rows<{
        provider_payment_id: string | null;
      }>(
        'SELECT provider_payment_id FROM commerce_payment_orders WHERE id=$1 FOR UPDATE',
        [orderId],
        sql,
      );
      if (
        locked!.provider_payment_id &&
        locked!.provider_payment_id !== result.providerId
      )
        throw new ConflictException('Provider idempotency violation');
      await sql.query(
        'UPDATE commerce_payment_orders SET provider_payment_id=$2 WHERE id=$1',
        [orderId, result.providerId],
      );
      await this.audit.record(
        sql,
        actor.id,
        'commerce.payment.started',
        'payment_order',
        orderId,
      );
    });
    await this.applyProviderSnapshot(
      orderId,
      {
        ...result,
        amountMinor: Number(order.amount_minor),
        currency: order.currency,
      },
      'provider',
    );
    return result;
  }
  async applyProviderSnapshot(
    orderId: string,
    body: unknown,
    source: 'provider' | 'reconciliation',
    lease?: { token: string },
  ) {
    parse(uuid, orderId);
    const snapshot = parse(providerSnapshotSchema, body);
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'commerce-payment:' + orderId,
      ]);
      if (lease) {
        const { rowCount } = await sql.query(
          'SELECT order_id FROM commerce_reconciliation_jobs WHERE order_id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',
          [orderId, lease.token],
        );
        if (!rowCount)
          throw new ConflictException('Reconciliation lease expired');
      }
      const [order] = await this.db.rows<{
        state: PaymentState;
        provider: string;
        provider_payment_id: string;
        amount_minor: string;
        currency: string;
      }>(
        'SELECT * FROM commerce_payment_orders WHERE id=$1 FOR UPDATE',
        [orderId],
        sql,
      );
      if (
        !order ||
        order.provider !== this.paymentProvider.name ||
        order.provider_payment_id !== snapshot.providerId ||
        Number(order.amount_minor) !== snapshot.amountMinor ||
        order.currency !== snapshot.currency
      )
        throw new ConflictException('Provider snapshot does not match order');
      if (order.state === snapshot.state)
        return { changed: false, state: order.state };
      const ranks: Partial<Record<PaymentState, number>> = {
        created: 0,
        pending: 1,
        authorized: 2,
        captured: 3,
        refunded: 4,
      };
      if (
        ranks[snapshot.state] !== undefined &&
        ranks[order.state] !== undefined &&
        ranks[snapshot.state]! < ranks[order.state]!
      )
        return { changed: false, state: order.state };
      const path: PaymentState[] = [];
      let state = order.state;
      if (state === 'created' && snapshot.state !== 'cancelled') {
        path.push('pending');
        state = 'pending';
      }
      if (snapshot.state === 'refunded' && state !== 'captured') {
        path.push('captured');
      }
      path.push(snapshot.state);
      let before = order.state;
      for (const next of path) {
        if (before === next) continue;
        this.policy.transition(before, next);
        await sql.query(
          `INSERT INTO commerce_payment_events(payment_order_id,from_state,to_state,source,event_key,payload) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            orderId,
            before,
            next,
            source,
            'snapshot:' + source + ':' + snapshot.providerId + ':' + next,
            JSON.stringify(snapshot),
          ],
        );
        before = next;
      }
      await sql.query(
        'UPDATE commerce_payment_orders SET state=$2,updated_at=now() WHERE id=$1',
        [orderId, snapshot.state],
      );
      if (snapshot.state === 'refunded')
        await sql.query(
          "UPDATE commerce_promotion_activations SET status='cancelled' WHERE payment_order_id=$1 AND status IN ('active','scheduled')",
          [orderId],
        );
      await this.audit.record(
        sql,
        null,
        'commerce.payment.reconciled',
        'payment_order',
        orderId,
        { from: order.state, to: snapshot.state, source },
      );
      return { changed: true, state: snapshot.state };
    });
  }
}

@Controller('v1/commerce')
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Public()
  @Post('webhook')
  webhook(
    @Headers('x-payment-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    if (!req.rawBody)
      throw new BadRequestException('Raw webhook body required');
    return this.commerce.webhook(signature, req.rawBody);
  }

  @Post('orders')
  createOrder(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.commerce.createOrder(actor, key, body);
  }

  @Post('orders/:id/start') start(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
  ) {
    return this.commerce.startPayment(a, id);
  }
  @AdminOnly() @Post('ads/campaigns/:id/events') event(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k: unknown,
  ) {
    return this.commerce.recordAdvertising(a, id, b, k);
  }
  @AdminOnly() @Get('reconciliation') jobs() {
    return this.commerce.reconciliationJobs();
  }
  @AdminOnly() @Post('reconciliation/:id/retry') retry(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
    @Headers('idempotency-key') k: unknown,
  ) {
    return this.commerce.retryReconciliation(a, id, k);
  }
  @Get('orders')
  orders(@CurrentActor() actor: Actor) {
    return this.commerce.orders(actor);
  }

  @Get('promotions')
  promotions() {
    return this.commerce.promotions();
  }

  @Post('promotions/activate')
  activatePromotion(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.commerce.activatePromotion(actor, body, key);
  }

  @Post('promotions/activations/:id/cancel')
  cancelActivation(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.commerce.transitionActivation(actor, id, 'cancelled');
  }

  @AdminOnly()
  @Post('ads/placements')
  createPlacement(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.commerce.createPlacement(actor, body, key);
  }

  @AdminOnly()
  @Post('ads/campaigns')
  createCampaign(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.commerce.createCampaign(actor, body, key);
  }

  @AdminOnly()
  @Get('ads/campaigns/:placementCode/active')
  activeCampaigns(@Param('placementCode') placementCode: string) {
    return this.commerce.activeCampaigns(placementCode);
  }

  @AdminOnly() @Patch('promotions/:code/:version') configureProduct(
    @CurrentActor() a: Actor,
    @Param('code') c: string,
    @Param('version') v: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k: unknown,
  ) {
    return this.commerce.configureProduct(a, c, v, b, k);
  }
  @AdminOnly() @Post('promotions/activations/:id/revoke') revoke(
    @CurrentActor() a: Actor,
    @Param('id') id: string,
  ) {
    return this.commerce.transitionActivation(a, id, 'cancelled');
  }
  @AdminOnly()
  @Post('promotions')
  createPromotion(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.commerce.createPromotion(actor, body, key);
  }
}

@Module({
  imports: [
    CommerceFeaturesModule,
    ListingAccessModule,
    AuditModule,
    PaidPlacementModule,
  ],
  controllers: [CommerceController],
  providers: [
    CommercePolicy,
    CommerceService,
    PaymentReconciliation,
    { provide: 'COMMERCE_SERVICE', useExisting: CommerceService },
    {
      provide: PaymentProvider,
      useClass: UnconfiguredPaymentProvider,
    },
  ],
  exports: [
    CommercePolicy,
    CommerceService,
    PaidPlacementModule,
    PaymentReconciliation,
    CommerceFeaturesModule,
  ],
})
export class CommerceModule {}
