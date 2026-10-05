import { Injectable, Module } from '@nestjs/common';
import { Audit } from '../audit/audit';
import { Database } from '../database/database';

export abstract class NotificationAdapter {
  abstract send(input: {
    channel: 'email' | 'push';
    userId: string;
    kind: string;
    payload: unknown;
  }): Promise<void>;
}

@Injectable()
export class DisabledNotificationAdapter extends NotificationAdapter {
  async send(): Promise<void> {
    throw new Error('Notification adapter not configured');
  }
}

@Injectable()
export class NotificationWorker {
  constructor(
    private readonly db: Database,
    private readonly adapter: NotificationAdapter,
    private readonly audit: Audit,
  ) {}

  async once() {
    const job = await this.db.transaction(async (sql) => {
      const [claimed] = await this.db.rows<{
        id: string;
        user_id: string;
        channel: 'email' | 'push';
        kind: string;
        payload: unknown;
        attempts: number;
      }>(
        `SELECT id,user_id,channel,kind,payload,attempts
         FROM notification_deliveries
         WHERE (status='pending' AND available_at<=now())
            OR (status='running' AND lease_until<now())
         ORDER BY available_at,id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [],
        sql,
      );
      if (!claimed) return null;

      const [preferences] = await this.db.rows<{
        email: boolean;
        push: boolean;
        transactional: boolean;
      }>(
        `SELECT email,push,transactional
         FROM notification_preferences
         WHERE user_id=$1`,
        [claimed.user_id],
        sql,
      );
      const enabled =
        claimed.kind.startsWith('transactional.')
          ? (preferences?.transactional ?? true)
          : claimed.channel === 'email'
            ? (preferences?.email ?? true)
            : (preferences?.push ?? true);

      if (!enabled) {
        await sql.query(
          `UPDATE notification_deliveries
           SET status='skipped',lease_until=NULL
           WHERE id=$1`,
          [claimed.id],
        );
        return null;
      }

      if (claimed.attempts >= 5) {
        await sql.query(
          `UPDATE notification_deliveries
           SET status='dead',lease_until=NULL,last_error='retry_exhausted'
           WHERE id=$1`,
          [claimed.id],
        );
        await this.audit.record(
          sql,
          null,
          'notification.dead',
          'notification_delivery',
          claimed.id,
          { attempts: claimed.attempts },
        );
        return null;
      }

      await sql.query(
        `UPDATE notification_deliveries
         SET status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes'
         WHERE id=$1`,
        [claimed.id],
      );
      return { ...claimed, attempts: claimed.attempts + 1 };
    });

    if (!job) return false;

    try {
      await this.adapter.send({
        channel: job.channel,
        userId: job.user_id,
        kind: job.kind,
        payload: job.payload,
      });
      await this.db.transaction(async (sql) => {
        const result = await sql.query(
          `UPDATE notification_deliveries
           SET status='sent',sent_at=now(),lease_until=NULL,last_error=NULL
           WHERE id=$1 AND status='running' AND attempts=$2
           RETURNING id`,
          [job.id, job.attempts],
        );
        if (!result.rowCount) return;
        await this.audit.record(
          sql,
          null,
          'notification.sent',
          'notification_delivery',
          job.id,
          { channel: job.channel, kind: job.kind },
        );
      });
    } catch {
      await this.db.transaction(async (sql) => {
        const terminal = job.attempts >= 5;
        await sql.query(
          `UPDATE notification_deliveries
           SET status=$2,
               available_at=now()+$3*interval '1 second',
               lease_until=NULL,
               last_error='delivery_failed'
           WHERE id=$1 AND status='running' AND attempts=$4`,
          [
            job.id,
            terminal ? 'dead' : 'pending',
            Math.min(3600, Math.pow(2, job.attempts) * 10),
            job.attempts,
          ],
        );
        await this.audit.record(
          sql,
          null,
          terminal ? 'notification.dead' : 'notification.retry',
          'notification_delivery',
          job.id,
          { attempt: job.attempts },
        );
      });
    }

    return true;
  }
}

@Module({
  providers: [
    NotificationWorker,
    {
      provide: NotificationAdapter,
      useClass: DisabledNotificationAdapter,
    },
  ],
  exports: [NotificationWorker, NotificationAdapter],
})
export class NotificationWorkerModule {}
