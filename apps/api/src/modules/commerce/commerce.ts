import {
  AdminOnly,
  Actor,
  CurrentActor,
  parse,
} from '../../common/security';
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
  Post,
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
    throw new ConflictException(
      `Invalid payment transition: ${from} -> ${to}`,
    );
}

export function normalizePaymentEventKey(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Payment event key is required');
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key))
    throw new BadRequestException('Invalid payment event key');
  return key;
}

export function promotionWindow(
  startsAt: string | undefined,
  durationHours: number,
): { startsAt: string; endsAt: string } {
  if (!Number.isInteger(durationHours) || durationHours < 1)
    throw new BadRequestException('Invalid promotion duration');
  const start = startsAt ? new Date(startsAt) : new Date();
  if (Number.isNaN(start.getTime()))
    throw new BadRequestException('Invalid promotion start time');
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + durationHours * 60 * 60 * 1000).toISOString(),
  };
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Idempotency key is required');
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw new BadRequestException('Invalid idempotency key');
  return key;
}

export type PromotionKind =
  | 'standard'
  | 'highlighted'
  | 'premium'
  | 'vip'
  | 'super_vip'
  | 'top';

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
  if (!Number.isInteger(product.priceMinor) || product.priceMinor < 0)
    throw new BadRequestException('Invalid promotion price');
  if (!/^[A-Z]{3}$/.test(product.currency))
    throw new BadRequestException('Invalid currency');
  if (!Number.isInteger(product.durationHours) || product.durationHours < 1)
    throw new BadRequestException('Invalid promotion duration');
  if (!Number.isInteger(product.priority) || product.priority < 0)
    throw new BadRequestException('Invalid promotion priority');
  if (!Number.isInteger(product.version) || product.version < 1)
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

export abstract class PaymentProvider {
  abstract createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  abstract refundPayment(
    providerId: string,
    amountMinor?: number,
  ): Promise<ProviderPayment>;
  abstract verifyWebhook(
    signature: string,
    payload: Buffer,
  ): Promise<boolean>;
  abstract parseWebhook(payload: Buffer): Promise<{
    orderId: string;
    eventKey: string;
    state: PaymentState;
  }>;
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
  async parseWebhook(): Promise<{
    orderId: string;
    eventKey: string;
    state: PaymentState;
  }> {
    throw new BadRequestException('Payment provider is not configured');
  }
}

const orderInput = z
  .object({
    amountMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().trim().min(1).max(200),
    provider: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  })
  .strict();

const promotionInput = z
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
    priceMinor: z.number().int(),
    currency: z.string(),
    durationHours: z.number().int(),
    priority: z.number().int(),
    enabled: z.boolean(),
    version: z.number().int(),
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
    private readonly paymentProvider: PaymentProvider,
  ) {}

  async createOrder(actor: Actor, key: unknown, body: unknown) {
    const input = parse(orderInput, body);
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
      return created;
    });
  }

  async applyPaymentEvent(
    orderId: string,
    eventKey: string,
    toState: PaymentState,
    source: string,
    payload: unknown,
  ) {
    eventKey = normalizePaymentEventKey(eventKey);
    if (!/^[a-z0-9_-]{2,40}$/.test(source))
      throw new BadRequestException('Invalid payment event source');

    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `commerce-payment:${orderId}`,
      ]);
      const [replayed] = await this.db.rows(
        'SELECT id FROM commerce_payment_events WHERE payment_order_id=$1 AND event_key=$2',
        [orderId, eventKey],
        sql,
      );
      if (replayed) return { replayed: true };

      const [order] = await this.db.rows<{ state: PaymentState }>(
        'SELECT state FROM commerce_payment_orders WHERE id=$1 FOR UPDATE',
        [orderId],
        sql,
      );
      if (!order) throw new BadRequestException('Unknown payment order');

      this.policy.transition(order.state, toState);
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

  async activatePromotion(actor: Actor, body: unknown) {
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

    return this.db.transaction(async (sql) => {
      const [product] = await this.db.rows<{
        id: string;
        duration_hours: number;
        enabled: boolean;
      }>(
        `SELECT id,duration_hours,enabled
         FROM commerce_promotion_products
         WHERE code=$1 AND version=$2`,
        [input.code, input.version],
        sql,
      );
      if (!product || !product.enabled)
        throw new BadRequestException('Promotion product unavailable');

      if (input.paymentOrderId) {
        const [payment] = await this.db.rows<{ state: PaymentState }>(
          `SELECT state
           FROM commerce_payment_orders
           WHERE id=$1 AND account_id=$2`,
          [input.paymentOrderId, actor.id],
          sql,
        );
        if (!payment || payment.state !== 'captured')
          throw new ConflictException('Captured payment required');
      }

      const window = promotionWindow(input.startsAt, product.duration_hours);
      const [activation] = await this.db.rows(
        `INSERT INTO commerce_promotion_activations(
          account_id,listing_id,promotion_product_id,payment_order_id,
          starts_at,ends_at,status
        ) VALUES(
          $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,
          CASE WHEN $5::timestamptz>now() THEN 'scheduled' ELSE 'active' END
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
      return activation;
    });
  }

  async webhook(signature: unknown, payload: Buffer) {
    if (typeof signature !== 'string' || !signature.trim())
      throw new BadRequestException('Webhook signature is required');
    if (!(await this.paymentProvider.verifyWebhook(signature, payload)))
      throw new BadRequestException('Invalid webhook signature');
    const event = await this.paymentProvider.parseWebhook(payload);
    return this.applyPaymentEvent(
      event.orderId,
      event.eventKey,
      event.state,
      'webhook',
      { providerEvent: event.eventKey },
    );
  }

  async createPromotion(body: unknown) {
    const product = this.policy.promotion(parse(promotionInput, body));
    const [row] = await this.db.rows(
      `INSERT INTO commerce_promotion_products(
        code,kind,version,price_minor,currency,duration_hours,priority,enabled
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING code,kind,version,price_minor,currency,duration_hours,priority,enabled`,
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
    );
    return row;
  }
}

@Controller('v1/commerce')
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Post('webhook')
  webhook(
    @Headers('x-payment-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    return this.commerce.webhook(
      signature,
      Buffer.from(JSON.stringify(body ?? {})),
    );
  }

  @Post('orders')
  createOrder(
    @CurrentActor() actor: Actor,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.commerce.createOrder(actor, key, body);
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
  ) {
    return this.commerce.activatePromotion(actor, body);
  }

  @AdminOnly()
  @Post('promotions')
  createPromotion(@Body() body: unknown) {
    return this.commerce.createPromotion(body);
  }
}

@Module({
  controllers: [CommerceController],
  providers: [
    CommercePolicy,
    CommerceService,
    {
      provide: PaymentProvider,
      useClass: UnconfiguredPaymentProvider,
    },
  ],
  exports: [CommercePolicy, CommerceService],
})
export class CommerceModule {}
