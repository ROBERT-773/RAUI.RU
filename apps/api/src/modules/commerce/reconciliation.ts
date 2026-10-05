import { paymentDeadline } from './timeout';
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database/database';
import { CommerceFeatures } from './features';
import type { CommerceService } from './commerce';
@Injectable()
export class PaymentReconciliation {
  constructor(
    readonly db: Database,
    readonly features: CommerceFeatures,
    @Inject('COMMERCE_SERVICE')
    readonly commerce: Pick<
      CommerceService,
      'paymentProvider' | 'applyProviderSnapshot' | 'expirePromotions'
    >,
  ) {}
  async tick() {
    const expired = await this.commerce.expirePromotions();
    if (
      !this.commerce.paymentProvider.configured ||
      !(await this.features.enabled('payments'))
    )
      return { checked: 0, expired: expired.length };
    await this.db.pool.query(
      `INSERT INTO commerce_reconciliation_jobs(order_id) SELECT id FROM commerce_payment_orders WHERE provider=$1 AND provider_payment_id IS NOT NULL AND state IN ('created','pending','authorized','captured') AND updated_at>now()-interval '90 days' ON CONFLICT(order_id) DO NOTHING`,
      [this.commerce.paymentProvider.name],
    );
    const lease = randomUUID();
    const [job] = await this.db.rows<{
      order_id: string;
      provider_payment_id: string;
    }>(
      `WITH candidate AS (SELECT j.order_id FROM commerce_reconciliation_jobs j JOIN commerce_payment_orders o ON o.id=j.order_id WHERE j.dead_at IS NULL AND j.available_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) AND o.provider=$2 AND o.provider_payment_id IS NOT NULL AND o.state IN ('created','pending','authorized','captured') ORDER BY j.available_at,j.order_id FOR UPDATE OF j SKIP LOCKED LIMIT 1), claimed AS (UPDATE commerce_reconciliation_jobs j SET lease_token=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM candidate c WHERE j.order_id=c.order_id RETURNING j.order_id) SELECT c.order_id,o.provider_payment_id FROM claimed c JOIN commerce_payment_orders o ON o.id=c.order_id`,
      [lease, this.commerce.paymentProvider.name],
    );
    if (!job) return { checked: 0, expired: expired.length };
    try {
      const snapshot = await paymentDeadline((signal) =>
        this.commerce.paymentProvider.lookupPayment(
          job.provider_payment_id,
          signal,
        ),
      );
      await this.commerce.applyProviderSnapshot(
        job.order_id,
        snapshot,
        'reconciliation',
        { token: lease },
      );
      await this.db.pool.query(
        `UPDATE commerce_reconciliation_jobs SET lease_token=NULL,lease_until=NULL,attempts=0,last_error=NULL,checked_at=now(),available_at=now()+interval '5 minutes' WHERE order_id=$1 AND lease_token=$2`,
        [job.order_id, lease],
      );
    } catch {
      await this.db.pool.query(
        `UPDATE commerce_reconciliation_jobs SET lease_token=NULL,lease_until=NULL,last_error='provider_snapshot_failed',available_at=now()+LEAST(3600,power(2,LEAST(attempts,12))::integer)*interval '1 second',dead_at=CASE WHEN attempts>=8 THEN now() ELSE NULL END WHERE order_id=$1 AND lease_token=$2`,
        [job.order_id, lease],
      );
    }
    return { checked: 1, expired: expired.length };
  }
}
