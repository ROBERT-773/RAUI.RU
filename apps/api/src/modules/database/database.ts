import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { loadConfig } from '../../config';
export type Sql = Pick<PoolClient, 'query'>;
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: loadConfig().DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 15000,
  });
  constructor() {
    this.pool.on('error', () => console.error('database_pool_error'));
  }
  async rows<T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
    sql: Sql = this.pool,
  ): Promise<T[]> {
    return (await sql.query<T>(text, values)).rows;
  }
  async transaction<T>(work: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect();
    try {
      await sql.query('BEGIN');
      await sql.query("SET LOCAL lock_timeout='5s'");
      const value = await work(sql);
      await sql.query('COMMIT');
      return value;
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    } finally {
      sql.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
