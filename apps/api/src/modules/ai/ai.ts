import {
  Injectable,
  Module,
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import {
  Actor,
  AdminOnly,
  CurrentActor,
  parse,
  verified,
  seller,
} from '../../common/security';
import { Database } from '../database/database';
import { Audit } from '../audit/audit';
import { ListingAccess, ListingAccessModule } from '../listings/access';
import { Trust, TrustModule, adminActor } from '../trust/trust';
import { Analytics, AnalyticsModule } from '../analytics/analytics';
import { loadConfig } from '../../config';
import {
  aiRequest,
  capabilities,
  Capability,
  flagRequest,
  PROMPT_VERSION,
} from './contracts';
import { runAi, redactQuery, interpretSearch } from './runtime';
import { AiProvider, GatewayAiProvider } from './provider';
@Injectable()
export class AiService {
  private providerFailures = 0;
  private retryAfter = 0;
  constructor(
    readonly db: Database,
    readonly audit: Audit,
    readonly access: ListingAccess,
    readonly trust: Trust,
    readonly analytics: Analytics,
    readonly provider: AiProvider,
  ) {}
  async enabled(code: Capability) {
    if (loadConfig().AI_ENABLED !== 'true') return false;
    const [flag] = await this.db.rows<{ enabled: boolean }>(
      'SELECT enabled FROM ai_feature_flags WHERE code=$1',
      [code],
    );
    return flag?.enabled === true;
  }
  async prepare(actor: Actor, input: ReturnType<typeof aiRequest.parse>) {
    const query = redactQuery(input.query ?? '');
    if (input.capability === 'search')
      return {
        query,
        filters: interpretSearch(query),
        uncertainty: 'Only explicit preferences are parsed; confirm filters',
      };
    if (input.capability === 'realtor')
      return {
        query,
        filters: interpretSearch(query),
        questions: [
          'Уточните бюджет и тип сделки',
          'Подтвердите район и обязательные характеристики',
        ],
        notice:
          'Assistant suggests search steps, not legal or financial advice',
      };
    if (input.capability === 'support')
      return {
        query,
        topics: [
          'Поиск и фильтры',
          'Избранное и сравнение',
          'Обращение к продавцу',
          'Черновик и модерация',
        ],
        notice:
          'Contact platform support for account, legal or payment decisions',
      };
    if (input.capability === 'analytics')
      return this.analytics.market(actor, {});
    const id = input.listingId!;
    if (['recommendations', 'valuation'].includes(input.capability)) {
      if (!(await this.access.visible(id))) await this.access.get(actor, id);
    } else {
      seller(actor);
      await this.access.get(actor, id);
    }
    const s = await this.trust.snapshot(id);
    const facts = {
      category: s.category_code,
      locality: s.locality,
      price: s.price ? Number(s.price) : null,
      area: s.attributes.area ?? null,
      rooms: s.attributes.rooms ?? null,
      floor: s.attributes.floor ?? null,
    };
    if (input.capability === 'description')
      return {
        facts,
        text: `${facts.category}, ${facts.locality}. ${facts.area ? 'Площадь: ' + facts.area + ' м². ' : ''}${facts.rooms ? 'Комнат: ' + facts.rooms + '. ' : ''}${facts.price ? 'Цена предложения: ' + facts.price + ' RUB.' : 'Уточните цену.'}`,
        notice: 'Only stored facts; review before manually applying text',
      };
    if (input.capability === 'photo')
      return {
        facts,
        photos: s.media.map((m) => ({
          state: m.state,
          width: m.variants.small?.width ?? null,
          height: m.variants.small?.height ?? null,
          quality:
            m.state !== 'ready'
              ? 'pending'
              : (m.variants.small?.width ?? 0) < 640
                ? 'review_resolution'
                : 'ready_for_review',
          classification: 'unknown',
        })),
        notice: 'Metadata quality hook only; no invented visual classification',
      };
    if (['moderation', 'duplicates'].includes(input.capability))
      return {
        ...(await this.trust.result(actor, id)),
        facts,
        notice:
          'Advisory only; core rules and human decisions remain authoritative',
      };
    if (input.capability === 'recommendations') {
      const listings = await this.db.rows(
        'SELECT id,title,price,category,locality FROM public_search_listings WHERE id<>$1 AND category=$2 AND locality=$3 ORDER BY published_at DESC,id LIMIT 10',
        [id, s.category_code, s.locality],
      );
      return {
        facts,
        listings,
        strategy: 'same-category-and-locality; no behavioral profiling',
      };
    }
    const market = await this.analytics.market(actor, {
      category: s.category_code,
      locality: s.locality,
      dealType: s.deal_type,
    });
    const cohort =
      market.cohorts.find((c) => c.deal_type === s.deal_type) ??
      market.cohorts[0];
    const area = Number(s.attributes.area);
    return {
      facts,
      status:
        cohort && Number.isFinite(area) && area > 0
          ? 'indicative'
          : 'insufficient_data',
      range:
        cohort && Number.isFinite(area) && area > 0
          ? {
              min: Math.round(Number(cohort.price_per_m2_p25) * area),
              max: Math.round(Number(cohort.price_per_m2_p75) * area),
              currency: 'RUB',
            }
          : null,
      notice: market.notice,
    };
  }
  async assist(actor: Actor, body: unknown) {
    verified(actor);
    const input = parse(aiRequest, body),
      fallback = await this.prepare(actor, input),
      cfg = loadConfig();
    const active = await this.enabled(input.capability),
      circuitOpen = active && Date.now() < this.retryAfter,
      amount = 2 * cfg.AI_CALL_CAP_MICROS;
    let day: string | undefined;
    if (active && !circuitOpen && amount <= cfg.AI_DAILY_BUDGET_MICROS) {
      const [reservation] = await this.db.rows<{ day: string }>(
        `INSERT INTO ai_budget_days(day,reserved_micros) VALUES(CURRENT_DATE,$1) ON CONFLICT(day) DO UPDATE SET reserved_micros=ai_budget_days.reserved_micros+$1 WHERE ai_budget_days.spent_micros+ai_budget_days.reserved_micros+$1<=$2 RETURNING day::text`,
        [amount, cfg.AI_DAILY_BUDGET_MICROS],
      );
      day = reservation?.day;
    }
    const answer = await runAi({
      capability: input.capability,
      context: fallback,
      fallback,
      provider: this.provider,
      maxCostMicros: cfg.AI_CALL_CAP_MICROS,
      enabled: () =>
        day ? this.enabled(input.capability) : Promise.resolve(false),
    });
    if (circuitOpen) answer.reason = 'circuit_open';
    else if (active && !day) answer.reason = 'budget_exhausted';
    if (answer.attempts > 0) {
      if (answer.reason === 'provider_unavailable') {
        this.providerFailures++;
        if (this.providerFailures >= 3) this.retryAfter = Date.now() + 60000;
      } else {
        this.providerFailures = 0;
        this.retryAfter = 0;
      }
    }
    await this.db.transaction(async (sql) => {
      if (day)
        await sql.query(
          'UPDATE ai_budget_days SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE day=$1',
          [day, amount, answer.costMicros],
        );
      await sql.query(
        'INSERT INTO ai_usage(capability,mode,reason,attempts,latency_ms,cost_micros,input_tokens,output_tokens,prompt_version,model_version,rule_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          input.capability,
          answer.mode,
          answer.reason,
          answer.attempts,
          answer.latencyMs,
          answer.costMicros,
          answer.inputTokens,
          answer.outputTokens,
          PROMPT_VERSION,
          answer.modelVersion,
          answer.ruleVersion,
        ],
      );
    });
    // Settle usage even when a live access recheck rejects the response after provider latency.
    if (
      input.listingId &&
      !['recommendations', 'valuation'].includes(input.capability)
    )
      await this.access.get(actor, input.listingId);
    if (['recommendations', 'valuation'].includes(input.capability))
      answer.result = await this.prepare(actor, input);
    return answer;
  }
  async flags(actor: Actor) {
    adminActor(actor);
    return this.db.rows('SELECT * FROM ai_feature_flags ORDER BY code');
  }
  async configure(actor: Actor, code: string, body: unknown) {
    adminActor(actor);
    parse(capabilities, code);
    const input = parse(flagRequest, body);
    return this.db.transaction(async (sql) => {
      const [flag] = await this.db.rows(
        'UPDATE ai_feature_flags SET enabled=$2,version=version+1,updated_at=now() WHERE code=$1 AND version=$3 RETURNING *',
        [code, input.enabled, input.version],
        sql,
      );
      if (!flag) throw new ConflictException('Stale AI feature version');
      await this.audit.record(
        sql,
        actor.id,
        'ai.flag.changed',
        'ai_feature',
        code,
        input,
      );
      return flag;
    });
  }
  async metrics(actor: Actor) {
    if (actor.role !== 'admin') throw new ForbiddenException();
    verified(actor);
    return this.db.rows(
      `SELECT capability,mode,reason,model_version,prompt_version,rule_version,count(*)::int AS calls,sum(attempts)::int AS attempts,sum(cost_micros)::text AS cost_micros,sum(input_tokens)::int AS input_tokens,sum(output_tokens)::int AS output_tokens,percentile_cont(.95) WITHIN GROUP(ORDER BY latency_ms) AS latency_p95_ms FROM ai_usage WHERE created_at>now()-interval '30 days' GROUP BY capability,mode,reason,model_version,prompt_version,rule_version ORDER BY capability,mode,reason LIMIT 100`,
    );
  }
}
@Controller('v1/ai')
class AiController {
  constructor(readonly ai: AiService) {}
  @Post('assist') assist(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.ai.assist(actor, body);
  }
}
@AdminOnly()
@Controller('v1/admin/ai')
class AiAdminController {
  constructor(readonly ai: AiService) {}
  @Get('features') flags(@CurrentActor() actor: Actor) {
    return this.ai.flags(actor);
  }
  @Patch('features/:code') configure(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Body() body: unknown,
  ) {
    return this.ai.configure(actor, code, body);
  }
  @Get('metrics') metrics(@CurrentActor() actor: Actor) {
    return this.ai.metrics(actor);
  }
}
@Module({
  imports: [ListingAccessModule, TrustModule, AnalyticsModule],
  providers: [AiService, { provide: AiProvider, useClass: GatewayAiProvider }],
  controllers: [AiController, AiAdminController],
  exports: [AiService],
})
export class AiModule {}
