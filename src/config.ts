import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://ingest:ingest@localhost:5433/ingest'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  QUEUE_PREFIX: z.string().default('hn'),
  HN_BASE_URL: z.string().url().default('https://hacker-news.firebaseio.com/v0'),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(8),
  /** Global (cross-worker) cap on upstream item fetches per second. */
  INGEST_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(10),
  INGEST_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  AUTHOR_CACHE_HOURS: z.coerce.number().nonnegative().default(24),
  DISCOVERY_EVERY_MINUTES: z.coerce.number().nonnegative().default(0),
  CHAOS_SOURCE_ENABLED: bool,
  WORKER_METRICS_PORT: z.coerce.number().int().default(9100),
});

export type Config = z.infer<typeof schema>;
export const config: Config = schema.parse(process.env);
