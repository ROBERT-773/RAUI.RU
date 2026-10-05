import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from './modules/database/database';
import { AuditModule } from './modules/audit/audit';
import { TrustWorker, TrustWorkerModule } from './modules/trust/worker';
import { Analytics, AnalyticsModule } from './modules/analytics/analytics';
@Module({
  imports: [DatabaseModule, AuditModule, TrustWorkerModule, AnalyticsModule],
})
class TrustProcessModule {}
async function run() {
  const app = await NestFactory.createApplicationContext(TrustProcessModule, {
    logger: ['error'],
  });
  const worker = app.get(TrustWorker),
    analytics = app.get(Analytics);
  let stopping = false,
    lastPrune = 0;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  try {
    do {
      if (Date.now() - lastPrune > 3600000) {
        await analytics.prune();
        lastPrune = Date.now();
      }
      const worked = await worker.once();
      if (process.argv.includes('--once')) break;
      if (!worked) await new Promise((done) => setTimeout(done, 1000));
    } while (!stopping);
  } finally {
    await app.close();
  }
}
void run().catch(() => {
  console.error('trust_worker_failed');
  process.exitCode = 1;
});
