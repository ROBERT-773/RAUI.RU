import { Controller, Get, Header, Injectable, Module } from '@nestjs/common';
import { AdminOnly } from '../../common/security';
import { Database } from '../database/database';
import { Dependencies } from '../../dependencies';
import { loadConfig } from '../../config';
import { Telemetry } from './telemetry';
export async function searchHealthy(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader || !response.ok) {
    await response.body?.cancel();
    return false;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) return false;
      chunks.push(next.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return (
      typeof body === 'object' &&
      body !== null &&
      ['green', 'yellow'].includes(
        String((body as { status?: unknown }).status),
      )
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
@Injectable()
export class Operations {
  constructor(
    private readonly db: Database,
    private readonly dependencies: Dependencies,
  ) {}
  async snapshot() {
    let dependencies = 'unavailable';
    try {
      await this.dependencies.check();
      dependencies = 'ok';
    } catch {
      /* sanitized dependency status */
    }
    const config = loadConfig();
    let search = 'unavailable';
    try {
      const response = await fetch(config.OPENSEARCH_URL + '/_cluster/health', {
        headers: config.OPENSEARCH_TOKEN
          ? { Authorization: 'Bearer ' + config.OPENSEARCH_TOKEN }
          : {},
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      if (await searchHealthy(response)) search = 'ok';
    } catch {
      /* no upstream errors or credentials */
    }
    const queues = await this.db.rows(`
      SELECT 'media' AS queue,state,count(*)::integer AS count,COALESCE(max(EXTRACT(EPOCH FROM now()-available_at)) FILTER (WHERE state IN ('pending','running')),0)::float AS oldest_seconds FROM media_jobs GROUP BY state
      UNION ALL SELECT 'professional',state,count(*)::integer,COALESCE(max(EXTRACT(EPOCH FROM now()-available_at)) FILTER (WHERE state IN ('pending','running')),0)::float FROM professional_import_jobs GROUP BY state
      UNION ALL SELECT 'notifications',status,count(*)::integer,COALESCE(max(EXTRACT(EPOCH FROM now()-available_at)) FILTER (WHERE status IN ('pending','running')),0)::float FROM notification_deliveries GROUP BY status
      UNION ALL SELECT 'trust',state,count(*)::integer,COALESCE(max(EXTRACT(EPOCH FROM now()-available_at)) FILTER (WHERE state IN ('pending','running')),0)::float FROM trust_jobs GROUP BY state
      UNION ALL SELECT 'search','pending',count(*)::integer,COALESCE(max(EXTRACT(EPOCH FROM now()-enqueued_at)),0)::float FROM search_jobs
      UNION ALL SELECT 'commerce',CASE WHEN dead_at IS NULL THEN 'pending' ELSE 'dead' END,count(*)::integer,COALESCE(max(EXTRACT(EPOCH FROM now()-available_at)) FILTER (WHERE dead_at IS NULL),0)::float FROM commerce_reconciliation_jobs GROUP BY dead_at IS NULL
    `);
    const flags = await this.db.rows(
      "SELECT 'ai' AS domain,code,enabled,version FROM ai_feature_flags UNION ALL SELECT 'commerce',code,enabled,version FROM commerce_feature_flags ORDER BY domain,code",
    );
    const failures = await this.db.rows<{
      ai_fallbacks: number;
      ai_failures: number;
      ai_uncertain: number;
    }>(
      "SELECT count(*) FILTER (WHERE mode='fallback')::integer AS ai_fallbacks,count(*) FILTER (WHERE attempts>0 AND reason='provider_unavailable')::integer AS ai_failures,count(*) FILTER (WHERE unknown_cost_attempts>0)::integer AS ai_uncertain FROM ai_usage WHERE created_at>now()-interval '1 hour'",
    );
    const payments = await this.db.rows<{ failed: number }>(
      "SELECT count(*) FILTER (WHERE state='failed')::integer AS failed FROM commerce_payment_orders WHERE created_at>now()-interval '1 hour'",
    );
    return {
      dependencies,
      search,
      queues,
      flags,
      failures: {
        ai_fallbacks: failures[0]?.ai_fallbacks ?? 0,
        ai_uncertain: failures[0]?.ai_uncertain ?? 0,
        ai_failures: failures[0]?.ai_failures ?? 0,
        payments: payments[0]?.failed ?? 0,
      },
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        rssBytes: process.memoryUsage().rss,
      },
    };
  }
}
@AdminOnly()
@Controller('v1/admin/operations')
export class OperationsController {
  constructor(
    private readonly operations: Operations,
    private readonly telemetry: Telemetry,
  ) {}
  @Get() snapshot() {
    return this.operations.snapshot();
  }
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics() {
    const state = await this.operations.snapshot();
    const lines = [
      this.telemetry.prometheus(),
      '# TYPE raui_dependency_up gauge',
      `raui_dependency_up{dependency="postgres_redis"} ${state.dependencies === 'ok' ? 1 : 0}`,
      `raui_dependency_up{dependency="opensearch"} ${state.search === 'ok' ? 1 : 0}`,
      '# TYPE raui_queue_jobs gauge',
      '# TYPE raui_queue_oldest_seconds gauge',
    ];
    for (const queue of state.queues) {
      lines.push(
        `raui_queue_jobs{queue="${queue.queue}",state="${queue.state}"} ${queue.count}`,
        `raui_queue_oldest_seconds{queue="${queue.queue}",state="${queue.state}"} ${Math.max(0, Number(queue.oldest_seconds))}`,
      );
    }
    lines.push(
      `# TYPE raui_provider_failures_hour gauge`,
      `raui_ai_fallbacks_hour ${state.failures.ai_fallbacks}`,
      `raui_provider_failures_hour{provider="ai"} ${state.failures.ai_failures}`,
      `raui_provider_failures_hour{provider="ai_uncertain"} ${state.failures.ai_uncertain}`,
      `raui_provider_failures_hour{provider="payment"} ${state.failures.payments}`,
    );
    return lines.join('\n') + '\n';
  }
}
@Module({
  controllers: [OperationsController],
  providers: [Operations, Dependencies, Telemetry],
  exports: [Telemetry],
})
export class OperationsModule {}
