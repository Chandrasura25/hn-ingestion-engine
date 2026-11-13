import { randomUUID } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { RateLimitedError } from '../domain/errors.js';
import type { IngestJobData } from '../pipeline/ingest.js';

export const QUEUE = { ingest: 'ingest', discover: 'discover' } as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export interface DiscoverJobData {
  source: string;
  scope: string;
  limit?: number;
  /** Re-ingest items even if an identical job ran recently. */
  force?: boolean;
}

export interface Queues {
  ingest: Queue<IngestJobData>;
  discover: Queue<DiscoverJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const opts = { connection, prefix: config.QUEUE_PREFIX };
  const ingest = new Queue<IngestJobData>(QUEUE.ingest, opts);
  const discover = new Queue<DiscoverJobData>(QUEUE.discover, opts);
  return {
    ingest,
    discover,
    async close() {
      await Promise.all([ingest.close(), discover.close()]);
    },
  };
}

/**
 * Layer 1 of dedup: a deterministic job id means BullMQ ignores a second enqueue of the same
 * item while the first is waiting/running/recently completed. Layer 2 is the DB unique key.
 * `force` appends a nonce to deliberately bypass layer 1 (refreshes, retries, chaos tests).
 */
export function ingestJobId(source: string, externalId: string, force = false): string {
  const base = `${source}_${externalId}`.replace(/:/g, '_');
  return force ? `${base}_${randomUUID().slice(0, 8)}` : base;
}

export function ingestJobOptions(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: config.INGEST_MAX_ATTEMPTS,
    backoff: { type: 'jittered' },
    removeOnComplete: { age: 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

export async function enqueueIngest(
  queue: Queue<IngestJobData>,
  items: IngestJobData[],
  force = false,
): Promise<Array<{ externalId: string; jobId: string }>> {
  const jobs = items.map((data) => {
    const jobId = ingestJobId(data.source, data.externalId, force);
    return { name: 'ingest', data, opts: ingestJobOptions(jobId) };
  });
  const added = [];
  for (let i = 0; i < jobs.length; i += 500) {
    added.push(...(await queue.addBulk(jobs.slice(i, i + 500))));
  }
  return added.map((j) => ({ externalId: j.data.externalId, jobId: j.id ?? '' }));
}

export async function enqueueDiscover(
  queue: Queue<DiscoverJobData>,
  data: DiscoverJobData,
): Promise<string> {
  const job = await queue.add('discover', data, {
    attempts: config.INGEST_MAX_ATTEMPTS,
    backoff: { type: 'jittered' },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  return job.id ?? '';
}

/**
 * Exponential backoff with "equal jitter" (half fixed, half random) so a burst of failures
 * doesn't retry in lockstep and hammer the upstream again. Honors Retry-After when given.
 */
export function computeBackoff(attemptsMade: number, err?: Error, rand = Math.random): number {
  if (err instanceof RateLimitedError) return err.retryAfterMs;
  const exp = Math.min(config.BACKOFF_MAX_MS, config.BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}
