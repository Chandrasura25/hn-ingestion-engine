import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString = config.DATABASE_URL): Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
