import {
  Injectable,
  Module,
  Controller,
  Get,
  Post,
  Param,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Audit, AuditModule } from '../audit/audit';
import { Database, Sql } from '../database/database';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  parse,
  uuid,
  verified,
} from '../../common/security';
import { loadConfig } from '../../config';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { priceMinor } from '../product/subscription-events';
import {
  listingSubscriptionDeliverySchema,
  listingSubscriptionConsentVersion,
} from '../product/subscription-contract';
import { publicIPv4 } from '../../common/outbound-policy';
export interface DeliveryEnvelope {
  channel: 'email' | 'push' | 'sms';
  userId: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  destination: string;
}
export abstract class NotificationAdapter {
  get configured(): boolean {
    return false;
  }
  abstract send(input: DeliveryEnvelope, signal: AbortSignal): Promise<void>;
}
@Injectable()
export class DisabledNotificationAdapter extends NotificationAdapter {
  async send(): Promise<void> {
    throw new Error('Notification adapter not configured');
  }
}
export function validateNotificationGatewayUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    url.hostname.startsWith('[')
  )
    throw new Error('notification_gateway_rejected');
  return url;
}

export async function resolveNotificationGatewayHost(
  hostname: string,
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (
    host,
  ) => lookup(host, { all: true }),
) {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some((x) => !publicIPv4(x.address)))
    throw new Error('notification_gateway_address_rejected');
  return addresses[0]!;
}

@Injectable()
export class GatewayNotificationAdapter extends NotificationAdapter {
  get configured() {
    return Boolean(loadConfig().NOTIFICATION_GATEWAY_URL);
  }
  async send(input: DeliveryEnvelope, signal: AbortSignal) {
    const cfg = loadConfig();
    if (!cfg.NOTIFICATION_GATEWAY_URL) throw new Error('unconfigured');
    const url = validateNotificationGatewayUrl(cfg.NOTIFICATION_GATEWAY_URL);
    const selected = await resolveNotificationGatewayHost(url.hostname);
    // Use the validated address for the socket while retaining the original TLS identity.
    // A node:https Agent is not an Undici dispatcher and cannot pin native fetch DNS.
    await new Promise<void>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          agent: false,
          family: 4,
          servername: url.hostname,
          rejectUnauthorized: true,
          lookup: (_host, _options, done) => done(null, selected.address, 4),
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.NOTIFICATION_GATEWAY_TOKEN!}`,
            'Idempotency-Key': input.idempotencyKey,
          },
        },
        (response) => {
          // No redirects or response body are consumed; only explicit acknowledgements count.
          response.destroy();
          if ([200, 201, 204].includes(response.statusCode ?? 0)) resolve();
          else reject(new Error('delivery_failed'));
        },
      );
      req.on('error', () => reject(new Error('delivery_failed')));
      req.end(JSON.stringify(input));
    });
  }
}
interface Job {
  id: string;
  user_id: string;
  channel: DeliveryEnvelope['channel'];
  kind: string;
  payload: unknown;
  dedupe_key: string;
  attempts: number;
  lease_token: string;
}
@Injectable()
export class NotificationWorker {
  constructor(
    private readonly db: Database,
    private readonly adapter: NotificationAdapter,
    private readonly audit: Audit,
    private readonly access: ListingAccess,
  ) {}
  // Bridge the existing product outbox; dedupe key remains stable across workers/restarts.
  async bridge() {
    await this.db.pool
      .query(`INSERT INTO notification_deliveries(user_id,channel,kind,dedupe_key,payload)
  SELECT n.user_id,o.channel,'message','notification-outbox:'||o.id,jsonb_build_object('notificationId',n.id,'threadId',n.thread_id)
  FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id WHERE o.state='pending'
  AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.user_id=n.user_id AND d.channel=o.channel AND d.dedupe_key='notification-outbox:'||o.id)
  ORDER BY o.id LIMIT 100 ON CONFLICT(user_id,channel,dedupe_key) DO NOTHING`);
  }
  async once() {
    await this.bridge();
    const job = await this.db.transaction(async (sql) => {
      const [j] = await this.db.rows<Job>(
        "SELECT * FROM notification_deliveries WHERE (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [],
        sql,
      );
      if (!j) return null;
      const lease = randomUUID();
      await sql.query(
        "UPDATE notification_deliveries SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1",
        [j.id, lease],
      );
      return { ...j, lease_token: lease, attempts: j.attempts + 1 };
    });
    if (!job) return false;
    try {
      if (job.kind.startsWith('subscription.listing.')) {
        // Serialize the final consent gate and transport with disable's row lock.
        await this.db.transaction((sql) => this.deliver(job, sql));
      } else {
        await this.deliver(job);
      }
    } catch {
      // SQL errors roll the delivery transaction back before retry finalization.
      await this.finish(job, 'failed');
    }
    return true;
  }
  private async deliver(job: Job, sql?: Sql) {
    let subscriptionPayload:
      z.infer<typeof listingSubscriptionDeliverySchema> | undefined;
    if (job.kind.startsWith('subscription.listing.')) {
      const payload = listingSubscriptionDeliverySchema.safeParse(job.payload);
      if (
        !payload.success ||
        job.channel !== 'email' ||
        job.kind !== `subscription.listing.${payload.data.event.kind}`
      ) {
        await this.finish(job, 'skipped', sql);
        return;
      }
      subscriptionPayload = payload.data;
      const [subscription] = await this.db.rows(
        `SELECT 1 FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2
           AND disabled_at IS NULL AND version=$3 AND 'email'=ANY(channels)
           AND $4=ANY(events) AND frequency='immediate' AND consent_version=$5 FOR UPDATE`,
        [
          job.user_id,
          payload.data.listingId,
          payload.data.subscriptionVersion,
          payload.data.event.kind,
          listingSubscriptionConsentVersion,
        ],
        sql,
      );
      if (!subscription) {
        await this.finish(job, 'skipped', sql);
        return;
      }
    }
    const [recipient] = await this.db.rows<{
      active: boolean;
      email: string;
      phone: string | null;
      email_verified_at: string | null;
      phone_verified_at: string | null;
      email_enabled: boolean;
      sms_enabled: boolean;
      push_enabled: boolean;
      transactional: boolean;
    }>(
      `SELECT u.active,u.email,u.phone,u.email_verified_at,u.phone_verified_at,COALESCE(p.email,false) AS email_enabled,COALESCE(p.sms,false) AS sms_enabled,COALESCE(p.push,false) AS push_enabled,COALESCE(p.transactional,true) AS transactional FROM users u LEFT JOIN notification_preferences p ON p.user_id=u.id WHERE u.id=$1`,
      [job.user_id],
      sql,
    );
    const enabled =
      recipient?.active &&
      (!job.kind.startsWith('transactional.') || recipient.transactional) &&
      (job.channel === 'email'
        ? recipient.email_enabled && recipient.email_verified_at
        : job.channel === 'sms'
          ? recipient.sms_enabled &&
            recipient.phone_verified_at &&
            recipient.phone
          : recipient.push_enabled);
    if (!enabled) {
      await this.finish(job, 'skipped', sql);
      return;
    }
    if (!this.adapter.configured) {
      await this.finish(job, 'deferred', sql);
      return;
    }
    if (sql) {
      // Consent -> job is the shared lock order. Claim committed before this gate.
      const [held] = await this.db.rows(
        "SELECT id FROM notification_deliveries WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",
        [job.id, job.lease_token],
        sql,
      );
      if (!held) return;
      // Evaluate time AFTER acquiring the job lock, never before a lock wait.
      const [valid] = await this.db.rows(
        "SELECT id FROM notification_deliveries WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp()+interval '4 seconds'",
        [job.id, job.lease_token],
        sql,
      );
      if (!valid) return;
    }
    if (subscriptionPayload) {
      const event = subscriptionPayload.event;
      let eligible = false;
      if (event.kind === 'availability' && !event.available) {
        // A single snapshot prevents eligibility/version reads observing different states.
        const current = await this.access.currentVisibility(
          subscriptionPayload.listingId,
          sql,
        );
        eligible =
          current !== undefined &&
          !current.visible &&
          current.version === subscriptionPayload.listingVersion;
      } else {
        const visible = await this.access.visible(
          subscriptionPayload.listingId,
          sql,
        );
        if (visible?.version === subscriptionPayload.listingVersion) {
          if (event.kind === 'availability') eligible = true;
          else {
            try {
              eligible =
                visible.price !== null &&
                priceMinor(visible.price) === event.priceMinor;
            } catch {
              eligible = false;
            }
          }
        }
      }
      if (!eligible) {
        await this.finish(job, 'skipped', sql);
        return;
      }
      // Visibility queries can wait: refresh remaining lease immediately before invoke.
      const [valid] = await this.db.rows(
        "SELECT id FROM notification_deliveries WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp()+interval '4 seconds'",
        [job.id, job.lease_token],
        sql,
      );
      if (!valid) return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.adapter.send(
          {
            channel: job.channel,
            userId: job.user_id,
            kind: job.kind,
            payload: job.payload,
            idempotencyKey: `notification:${job.id}`,
            destination:
              job.channel === 'email'
                ? recipient!.email
                : job.channel === 'sms'
                  ? recipient!.phone!
                  : job.user_id,
          },
          controller.signal,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error('delivery_deadline'));
            },
            sql ? 3000 : 5000,
          );
        }),
      ]);
    } catch {
      await this.finish(job, 'failed', sql);
      return;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await this.finish(job, 'sent', sql);
  }

  async finish(
    job: Job,
    result: 'sent' | 'skipped' | 'deferred' | 'failed',
    sql?: Sql,
  ) {
    const complete = async (sql: Sql) => {
      const [held] = await this.db.rows(
        "SELECT id FROM notification_deliveries WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",
        [job.id, job.lease_token],
        sql,
      );
      if (!held) return;
      const [valid] = await this.db.rows(
        "SELECT id FROM notification_deliveries WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp()",
        [job.id, job.lease_token],
        sql,
      );
      if (!valid) return;
      if (result === 'deferred') {
        await sql.query(
          "UPDATE notification_deliveries SET status='pending',attempts=attempts-1,available_at=now()+interval '1 hour',lease_token=NULL,lease_until=NULL,last_error='transport_unconfigured' WHERE id=$1",
          [job.id],
        );
        return;
      }
      const state =
        result === 'failed' ? (job.attempts >= 5 ? 'dead' : 'pending') : result;
      await sql.query(
        "UPDATE notification_deliveries SET status=$2,available_at=now()+interval '1 second'*LEAST(3600,10*power(2,attempts)),lease_token=NULL,lease_until=NULL,last_error=CASE WHEN $2 IN ('pending','dead') THEN 'delivery_failed' ELSE NULL END,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1",
        [job.id, state],
      );
      if (state === 'sent' || state === 'skipped')
        await sql.query(
          "UPDATE notification_outbox SET state=$2 WHERE 'notification-outbox:'||id=$1 AND state='pending'",
          [job.dedupe_key, state === 'sent' ? 'delivered' : 'dead'],
        );
      await this.audit.record(
        sql,
        null,
        state === 'pending' ? 'notification.retry' : `notification.${state}`,
        'notification_delivery',
        job.id,
        { channel: job.channel, kind: job.kind, attempt: job.attempts },
      );
    };
    if (sql) await complete(sql);
    else await this.db.transaction(complete);
  }
  async retry(actor: Actor, id: string) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    return this.db.transaction(async (sql) => {
      const [row] = await this.db.rows(
        "UPDATE notification_deliveries SET status='pending',attempts=0,available_at=now(),last_error=NULL WHERE id=$1 AND status='dead' RETURNING id",
        [parse(uuid, id)],
        sql,
      );
      if (!row) throw new ConflictException('Dead delivery required');
      await this.audit.record(
        sql,
        actor.id,
        'notification.admin_retry',
        'notification_delivery',
        id,
      );
      return row;
    });
  }
  async inspect(actor: Actor) {
    verified(actor);
    if (actor.role !== 'admin') throw new ForbiddenException();
    return this.db.rows(
      'SELECT id,user_id,channel,kind,status,attempts,last_error,available_at,sent_at FROM notification_deliveries ORDER BY id LIMIT 100',
    );
  }
}
@Controller('v1/admin/integrations/notifications')
@AdminOnly()
export class NotificationAdminController {
  constructor(private readonly worker: NotificationWorker) {}
  @Get() list(@CurrentActor() a: Actor) {
    return this.worker.inspect(a);
  }
  @Post(':id/retry') retry(@CurrentActor() a: Actor, @Param('id') id: string) {
    return this.worker.retry(a, id);
  }
}
@Module({
  imports: [AuditModule, ListingAccessModule],
  controllers: [NotificationAdminController],
  providers: [
    NotificationWorker,
    { provide: NotificationAdapter, useClass: GatewayNotificationAdapter },
  ],
  exports: [NotificationWorker, NotificationAdapter],
})
export class NotificationWorkerModule {}
