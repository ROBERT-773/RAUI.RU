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

  @AdminOnly()
  @Post('promotions')
  createPromotion(@Body() body: unknown) {
    return this.commerce.createPromotion(body);
  }
}

@Module({
  controllers: [CommerceController],
  providers: [CommercePolicy, CommerceService],
  exports: [CommercePolicy, CommerceService],
})
export class CommerceModule {}
