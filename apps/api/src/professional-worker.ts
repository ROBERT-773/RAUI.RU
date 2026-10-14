import 'reflect-metadata';
import { releaseDailyInbox } from './modules/product/subscription-daily';
import { ListingAccess } from './modules/listings/access';
import { Database } from './modules/database/database';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ProfessionalImports,
  ProfessionalImportsModule,
} from './modules/professional/imports';
import { AuditModule } from './modules/audit/audit';
import { DatabaseModule } from './modules/database/database';
import {
  NotificationWorker,
  NotificationWorkerModule,
} from './modules/professional/notifications';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    NotificationWorkerModule,
    ProfessionalImportsModule,
  ],
})
class ProfessionalWorkerModule {}

async function run() {
  const app = await NestFactory.createApplicationContext(
    ProfessionalWorkerModule,
    {
      logger: ['error'],
    },
  );
  const worker = app.get(NotificationWorker),
    imports = app.get(ProfessionalImports);
  let stopping = false;

  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });

  try {
    do {
      const daily = await releaseDailyInbox(
        app.get(Database),
        app.get(ListingAccess),
      );
      const worked = await worker.once();
      const imported = await imports.once();
      if (process.argv.includes('--once')) break;
      if (!worked && !imported && !daily)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally {
    await app.close();
  }
}

void run().catch(() => {
  console.error('professional_worker_failed');
  process.exitCode = 1;
});
