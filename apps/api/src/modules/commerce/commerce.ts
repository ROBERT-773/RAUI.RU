import { BadRequestException, ConflictException, Injectable, Module } from '@nestjs/common';

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

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('Idempotency key is required');
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
  abstract refundPayment(providerId: string, amountMinor?: number): Promise<ProviderPayment>;
  abstract verifyWebhook(signature: string, payload: Buffer): Promise<boolean>;
}

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

@Module({
  providers: [CommercePolicy],
  exports: [CommercePolicy],
})
export class CommerceModule {}
