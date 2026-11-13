import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgres://ingest:ingest@localhost:5433/ingest_test',
      REDIS_URL: 'redis://localhost:6380',
      QUEUE_PREFIX: 'test',
      BACKOFF_BASE_MS: '20',
      LOG_LEVEL: 'silent',
    },
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
