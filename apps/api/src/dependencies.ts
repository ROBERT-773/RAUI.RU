import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from './config';
@Injectable()
export class Dependencies implements OnModuleDestroy {
  private readonly config = loadConfig();
  private readonly pool = new Pool({
    connectionString: this.config.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    max: 5,
  });
  private readonly redis = createClient({
    url: this.config.REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  private connecting: Promise<unknown> | undefined;
  constructor() {
    this.redis.on('error', () => {});
    this.pool.on('error', () => {});
  }
  async check() {
    const db = await this.pool.query<{ version: string }>(
      'SELECT PostGIS_Version() AS version',
    );
    if (!db.rows[0]?.version) throw new Error('PostGIS unavailable');
    if (!this.redis.isOpen) {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    if (
      (await this.redis.withAbortSignal(AbortSignal.timeout(2000)).ping()) !==
      'PONG'
    )
      throw new Error('Redis unavailable');
  }
  async onModuleDestroy() {
    if (this.redis.isOpen) this.redis.destroy();
    await this.pool.end();
  }
}
