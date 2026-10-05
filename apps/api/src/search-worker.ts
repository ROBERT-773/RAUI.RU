import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './modules/database/database';
import { SearchModule, Search } from './modules/search/search';
import { SearchIndex } from './modules/search/index';
@Module({ imports: [DatabaseModule, SearchModule] })
class WorkerModule {}
async function run() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error'],
  });
  const search = app.get(Search),
    index = app.get(SearchIndex),
    sql = await search.db.pool.connect();
  let stopping = false,
    nextReconcile = Date.now();
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  try {
    await sql.query('SELECT pg_advisory_lock(734302)');
    try {
      await index.initialize();
    } finally {
      await sql.query('SELECT pg_advisory_unlock(734302)');
    }
    if (process.argv.includes('--reindex')) await search.reindex();
    if (process.argv.includes('--reconcile')) nextReconcile = 0;
    do {
      const { rows } = await sql.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(734302) AS locked',
      );
      let count = 0;
      if (rows[0]!.locked) {
        try {
          if (
            (!process.argv.includes('--once') ||
              process.argv.includes('--reconcile')) &&
            Date.now() >= nextReconcile
          ) {
            await search.reconcile();
            nextReconcile = Date.now() + 3600000;
          }
          count = await search.sync();
        } finally {
          await sql.query('SELECT pg_advisory_unlock(734302)');
        }
      }
      if (process.argv.includes('--once') && rows[0]!.locked && count === 0)
        break;
      if (count === 0)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally {
    sql.release();
    await app.close();
  }
}
run().catch(() => {
  console.error('search_worker_failed');
  process.exitCode = 1;
});
