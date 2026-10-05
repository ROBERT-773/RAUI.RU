import { Injectable } from '@nestjs/common';
export type NotificationChannel = 'email' | 'sms' | 'push';
export interface NotificationEnvelope {
  id: string;
  userId: string;
  threadId: string;
  channel: NotificationChannel;
  idempotencyKey: string;
}
// Transport adapters must honor idempotencyKey; an unconfigured adapter does not acknowledge delivery.
export abstract class NotificationTransport {
  abstract deliver(
    envelope: NotificationEnvelope,
  ): Promise<'delivered' | 'deferred'>;
}
@Injectable()
export class UnconfiguredNotificationTransport extends NotificationTransport {
  async deliver() {
    return 'deferred' as const;
  }
}
