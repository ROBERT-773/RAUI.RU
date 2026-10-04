import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './modules/database/database';
import { AuditModule } from './modules/audit/audit';
import { MediaWorker, WorkerModule } from './modules/media/worker';
@Module({ imports: [DatabaseModule, AuditModule, WorkerModule] })
class WorkerApp {}
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerApp);
  const worker = app.get(MediaWorker);
  let stopping = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    if (!(await worker.once()))
      await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await app.close();
}
void main().catch(() => {
  console.error('media_worker_failed');
  process.exitCode = 1;
});
