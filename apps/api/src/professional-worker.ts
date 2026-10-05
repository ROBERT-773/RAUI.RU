import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditModule } from './modules/audit/audit';
import { DatabaseModule } from './modules/database/database';
import {
  NotificationWorker,
  NotificationWorkerModule,
} from './modules/professional/notifications';

@Module({
  imports: [DatabaseModule, AuditModule, NotificationWorkerModule],
})
class ProfessionalWorkerModule {}

async function run() {
  const app = await NestFactory.createApplicationContext(ProfessionalWorkerModule, {
    logger: ['error'],
  });
  const worker = app.get(NotificationWorker);
  let stopping = false;

  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });

  try {
    do {
      const worked = await worker.once();
      if (process.argv.includes('--once')) break;
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally {
    await app.close();
  }
}

void run().catch(() => {
  console.error('professional_worker_failed');
  process.exitCode = 1;
});
