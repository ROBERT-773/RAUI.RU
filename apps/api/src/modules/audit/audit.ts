import { Global, Injectable, Module } from '@nestjs/common';
import { Database, Sql } from '../database/database';
@Injectable()
export class Audit {
  constructor(private readonly db: Database) {}
  async record(
    sql: Sql,
    actor: string | null,
    action: string,
    type: string,
    id: string,
    data: unknown = {},
  ) {
    await sql.query(
      'INSERT INTO audit_events(actor_id,action,entity_type,entity_id,data) VALUES($1,$2,$3,$4,$5)',
      [actor, action, type, id, JSON.stringify(data)],
    );
  }
  async history(
    sql: Sql,
    actor: string,
    listing: string,
    event: string,
    before: unknown,
    after: unknown,
  ) {
    await sql.query(
      'INSERT INTO listing_history(listing_id,actor_id,event,before_data,after_data) VALUES($1,$2,$3,$4,$5)',
      [listing, actor, event, JSON.stringify(before), JSON.stringify(after)],
    );
    await this.record(sql, actor, event, 'listing', listing, after);
  }
}
@Global()
@Module({ providers: [Audit], exports: [Audit] })
export class AuditModule {}
