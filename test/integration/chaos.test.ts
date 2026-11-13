import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { logger } from '../../src/logger.js';
import { createQueues, enqueueIngest, type Queues } from '../../src/queue/queues.js';
import { ChaosSource } from '../../src/sources/chaos/source.js';
import { SourceRegistry } from '../../src/sources/registry.js';
import { startWorkers, type Workers } from '../../src/worker/workers.js';

/**
 * End-to-end reliability test against a hostile upstream:
 * every item is enqueued twice, concurrently, and most items fail 1–3 times first
 * (429s, timeouts, 503s, truncated bodies). The store must still end up exactly right.
 */
const ITEM_COUNT = 120;

let pool: Pool;
let redis: Redis;
let queues: Queues;
let workers: Workers;
const chaos = new ChaosSource({ itemCount: ITEM_COUNT, seed: 42, rateLimitRetryMs: 30 });

const ids = Array.from({ length: ITEM_COUNT }, (_, i) => i + 1);
const okIds = ids.filter((id) => !chaos.plan(id).missing && !chaos.plan(id).corrupt);
const deadIds = ids.filter((id) => chaos.plan(id).missing || chaos.plan(id).corrupt);
const jobIds = okIds.filter((id) => chaos.plan(id).job);
const editedIds = okIds.filter((id) => chaos.plan(id).edits);

async function drain(queue: Queue, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    if (Object.values(c).every((n) => n === 0)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('queue did not drain in time');
}

function hints(id: number) {
  return chaos.plan(id).job ? { jobOrigin: 'who_is_hiring' as const } : undefined;
}

beforeAll(async () => {
  pool = createPool();
  await migrate(pool);
  await pool.query('TRUNCATE posts, post_versions, job_postings, authors, ingestion_failures RESTART IDENTITY CASCADE');
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queues = createQueues(redis);
  await queues.ingest.obliterate({ force: true });
  await queues.discover.obliterate({ force: true });
  workers = startWorkers({
    connection: redis, pool, queues, log: logger,
    sources: new SourceRegistry([chaos]),
    concurrency: 16,
    rateLimitPerSec: 5000,
  });
});

afterAll(async () => {
  await workers?.close();
  await queues?.close();
  await pool?.end();
  redis?.disconnect();
});

describe('ingestion under chaos', () => {
  it('converges to exactly one correct record per item despite duplicates and failures', async () => {
    const batch = ids.map((id) => ({ source: 'chaos', externalId: String(id), hints: hints(id) }));
    // force=true bypasses queue-level dedup so duplicates really race each other in the DB.
    await Promise.all([enqueueIngest(queues.ingest, batch, true), enqueueIngest(queues.ingest, batch, true)]);
    await drain(queues.ingest);

    const posts = await pool.query<{ external_id: string; version: number; title: string | null; body: string | null; quality_issues: string[] }>(
      `SELECT external_id, version, title, body, quality_issues FROM posts WHERE source = 'chaos'`,
    );
    // Nothing lost, nothing duplicated, nothing invalid stored.
    expect(posts.rows.map((r) => Number(r.external_id)).sort((a, b) => a - b)).toEqual(okIds);

    // Edited items: the newer content wins and the old one is kept in history.
    const byId = new Map(posts.rows.map((r) => [Number(r.external_id), r]));
    for (const id of editedIds) {
      const row = byId.get(id)!;
      expect(row.version, `item ${id}`).toBe(2);
      expect(`${row.title ?? ''}${row.body ?? ''}`).toMatch(/edited|UPDATED/);
    }
    for (const id of okIds.filter((i) => !chaos.plan(i).edits)) expect(byId.get(id)!.version).toBe(1);
    const versions = await pool.query('SELECT count(*)::int AS n FROM post_versions');
    expect(versions.rows[0].n).toBe(editedIds.length);

    // Partial upstream records were stored and flagged, not dropped.
    for (const id of okIds.filter((i) => chaos.plan(i).partial)) {
      expect(byId.get(id)!.quality_issues).toEqual(expect.arrayContaining(['invalid_by', 'missing_time']));
    }

    // Only permanently broken items reached the dead-letter table, each with the right class.
    const failures = await pool.query<{ external_id: string; error_class: string }>(
      `SELECT DISTINCT external_id, error_class FROM ingestion_failures`,
    );
    expect(failures.rows.map((r) => Number(r.external_id)).sort((a, b) => a - b)).toEqual(deadIds);
    for (const f of failures.rows) {
      const plan = chaos.plan(Number(f.external_id));
      expect(f.error_class).toBe(plan.missing ? 'not_found' : 'invalid_payload');
    }
  });

  it('extracts job contacts and treats author enrichment as best-effort', async () => {
    const { rows } = await pool.query<{ external_id: string; company: string; remote: boolean; emails: Array<{ address: string; origin: string }>; linkedin_urls: string[] }>(
      `SELECT p.external_id, j.company, j.remote, j.emails, j.linkedin_urls
         FROM job_postings j JOIN posts p ON p.id = j.post_id WHERE p.source = 'chaos'`,
    );
    expect(rows.map((r) => Number(r.external_id)).sort((a, b) => a - b)).toEqual(jobIds);
    for (const r of rows) {
      const id = Number(r.external_id);
      expect(r.company).toBe(`Acme ${id}`);
      expect(r.remote).toBe(true);
      expect(r.emails).toContainEqual(expect.objectContaining({ address: `jobs-${id}@example.com`, origin: 'post' }));
      const authorReachable = id % 2 === 0 && !chaos.plan(id).partial;
      expect(r.linkedin_urls).toEqual(authorReachable ? [`https://www.linkedin.com/in/user${id}-example`] : []);
    }
  });

  it('is idempotent: re-ingesting everything changes nothing', async () => {
    const before = await pool.query(`SELECT external_id, version, content_hash FROM posts ORDER BY external_id`);
    const batch = okIds.map((id) => ({ source: 'chaos', externalId: String(id), hints: hints(id) }));
    await enqueueIngest(queues.ingest, batch, true);
    await drain(queues.ingest);
    const after = await pool.query(`SELECT external_id, version, content_hash FROM posts ORDER BY external_id`);
    expect(after.rows).toEqual(before.rows);
  });

  it('dedupes at the queue layer when not forced', async () => {
    const jobs = await enqueueIngest(queues.ingest, [
      { source: 'chaos', externalId: '1' },
      { source: 'chaos', externalId: '1' },
    ]);
    expect(new Set(jobs.map((j) => j.jobId)).size).toBe(1);
    await drain(queues.ingest);
  });
});
