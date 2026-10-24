import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Actor, parse, uuid } from '../../common/security';
import { Database } from '../database/database';
import { ListingAccess } from '../listings/access';
import {
  listingSubscriptionSchema,
  listingSubscriptionDisableSchema,
  listingSubscriptionConsentVersion,
} from './subscription-contract';

@Injectable()
export class ListingSubscriptions {
  constructor(
    private readonly db: Database,
    private readonly access: ListingAccess,
  ) {}

  async list(actor: Actor) {
    return this.db.rows(
      'SELECT listing_id,events,channels,frequency,version,consented_at FROM listing_subscriptions WHERE user_id=$1 AND disabled_at IS NULL ORDER BY updated_at DESC,listing_id LIMIT 100',
      [actor.id],
    );
  }

  async subscribe(actor: Actor, id: unknown, body: unknown) {
    const listingId = parse(uuid, id);
    const input = parse(listingSubscriptionSchema, body);
    if (!(await this.access.visible(listingId))) throw new NotFoundException();
    const [row] = await this.db.rows(
      `INSERT INTO listing_subscriptions(user_id,listing_id,events,channels,frequency,consent_version)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id,listing_id) DO UPDATE SET events=EXCLUDED.events,channels=EXCLUDED.channels,frequency=EXCLUDED.frequency,consent_version=EXCLUDED.consent_version,consented_at=now(),disabled_at=NULL,version=listing_subscriptions.version+1,updated_at=now()
       RETURNING listing_id,events,channels,frequency,version,consented_at`,
      [
        actor.id,
        listingId,
        input.events,
        input.channels,
        input.frequency,
        listingSubscriptionConsentVersion,
      ],
    );
    return row;
  }

  async disable(actor: Actor, id: unknown, body: unknown) {
    const listingId = parse(uuid, id);
    const input = parse(listingSubscriptionDisableSchema, body);
    return this.db.transaction(async (sql) => {
      const [current] = await this.db.rows<{ version: number }>(
        'SELECT version FROM listing_subscriptions WHERE user_id=$1 AND listing_id=$2 FOR UPDATE',
        [actor.id, listingId],
        sql,
      );
      if (!current) throw new NotFoundException();
      if (current.version !== input.version)
        throw new ConflictException('Stale subscription version');
      await sql.query(
        'UPDATE listing_subscriptions SET disabled_at=now(),updated_at=now(),version=version+1 WHERE user_id=$1 AND listing_id=$2',
        [actor.id, listingId],
      );
      return { ok: true };
    });
  }
}
