import {
  Injectable,
  Module,
  Controller,
  Get,
  Patch,
  Body,
  Param,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { Database, Sql } from '../database/database';
import { Audit, AuditModule } from '../audit/audit';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  parse,
  hash,
} from '../../common/security';
import { normalizeIdempotencyKey } from './keys';
export const commerceFeatures = z.enum([
  'payments',
  'promotions',
  'advertising',
]);
export type CommerceFeature = z.infer<typeof commerceFeatures>;
export const featureInput = z
  .object({ enabled: z.boolean(), version: z.number().int().positive() })
  .strict();
@Injectable()
export class CommerceFeatures {
  constructor(
    readonly db: Database,
    readonly audit: Audit,
  ) {}
  async enabled(code: CommerceFeature, sql: Sql = this.db.pool) {
    const [row] = await this.db.rows<{ enabled: boolean }>(
      'SELECT enabled FROM commerce_feature_flags WHERE code=$1',
      [code],
      sql,
    );
    return row?.enabled === true;
  }
  async require(code: CommerceFeature, sql: Sql = this.db.pool) {
    if (!(await this.enabled(code, sql)))
      throw new ServiceUnavailableException('Commercial feature disabled');
  }
  async list() {
    return this.db.rows('SELECT * FROM commerce_feature_flags ORDER BY code');
  }
  async configure(actor: Actor, code: string, body: unknown) {
    const input = parse(featureInput, body);
    parse(commerceFeatures, code);
    return this.db.transaction(async (sql) => {
      const [row] = await this.db.rows(
        'UPDATE commerce_feature_flags SET enabled=$2,version=version+1,updated_at=now() WHERE code=$1 AND version=$3 RETURNING *',
        [code, input.enabled, input.version],
        sql,
      );
      if (!row) throw new ConflictException('Feature flag version changed');
      await this.audit.record(
        sql,
        actor.id,
        'commerce.flag.changed',
        'commerce_feature',
        code,
        input,
      );
      return row;
    });
  }
  async idempotent<T>(
    actor: Actor,
    scope: string,
    key: unknown,
    body: unknown,
    work: (sql: Sql) => Promise<T>,
  ) {
    const normalized = normalizeIdempotencyKey(key),
      fingerprint = hash(JSON.stringify(body));
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        actor.id + ':' + scope + ':' + normalized,
      ]);
      const [prior] = await this.db.rows<{ request_hash: string; response: T }>(
        'SELECT request_hash,response FROM idempotency_records WHERE actor_id=$1 AND scope=$2 AND key=$3',
        [actor.id, scope, normalized],
        sql,
      );
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new ConflictException(
            'Idempotency key reused with another payload',
          );
        return prior.response;
      }
      const response = await work(sql);
      await sql.query(
        'INSERT INTO idempotency_records(actor_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)',
        [actor.id, scope, normalized, fingerprint, JSON.stringify(response)],
      );
      return response;
    });
  }
}
@Controller('v1/commerce/features')
class FeaturesController {
  constructor(readonly features: CommerceFeatures) {}
  @AdminOnly() @Get() list() {
    return this.features.list();
  }
  @AdminOnly() @Patch(':code') configure(
    @CurrentActor() a: Actor,
    @Param('code') c: string,
    @Body() b: unknown,
  ) {
    return this.features.configure(a, c, b);
  }
}
@Module({
  imports: [AuditModule],
  providers: [CommerceFeatures],
  controllers: [FeaturesController],
  exports: [CommerceFeatures],
})
export class CommerceFeaturesModule {}
