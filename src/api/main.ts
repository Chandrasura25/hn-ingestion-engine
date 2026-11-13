import { Redis } from 'ioredis';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { logger } from '../logger.js';
import { collectDefaultMetrics } from '../metrics.js';
import { createQueues } from '../queue/queues.js';
import { buildApp } from './app.js';

collectDefaultMetrics();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const pool = createPool();
const queues = createQueues(redis);
const sourceNames = ['hackernews', ...(config.CHAOS_SOURCE_ENABLED ? ['chaos'] : [])];
const app = buildApp({ pool, redis, queues, log: logger.child({ component: 'api' }), sourceNames });

await app.listen({ host: '0.0.0.0', port: config.PORT });

async function shutdown() {
  await app.close();
  await queues.close();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
