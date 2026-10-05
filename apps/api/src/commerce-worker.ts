import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './modules/database/database';
import { AuditModule } from './modules/audit/audit';
import { CommerceModule } from './modules/commerce/commerce';
import { PaymentReconciliation } from './modules/commerce/reconciliation';
@Module({ imports: [DatabaseModule, AuditModule, CommerceModule] })
class CommerceWorkerModule {}
async function run() {
  const app = await NestFactory.createApplicationContext(CommerceWorkerModule, {
    logger: ['error'],
  });
  const worker = app.get(PaymentReconciliation);
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  try {
    do {
      const result = await worker.tick();
      if (process.argv.includes('--once')) break;
      if (result.checked === 0)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally {
    await app.close();
  }
}
run().catch(() => {
  console.error('commerce_worker_failed');
  process.exitCode = 1;
});
