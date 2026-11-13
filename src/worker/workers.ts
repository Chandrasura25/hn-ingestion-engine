import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { recordFailure } from '../db/repository.js';
import type { Pool } from '../db/pool.js';
import { classify, isRetryable, RateLimitedError } from '../domain/errors.js';
import type { Logger } from '../logger.js';
import { metrics } from '../metrics.js';
import { ingestItem, type IngestJobData, type IngestResult } from '../pipeline/ingest.js';
import {
  computeBackoff,
  enqueueIngest,
  QUEUE,
  type DiscoverJobData,
  type Queues,
} from '../queue/queues.js';
import type { SourceRegistry } from '../sources/registry.js';

export interface WorkerDeps {
  connection: Redis;
  pool: Pool;
  sources: SourceRegistry;
  queues: Queues;
  log: Logger;
  concurrency?: number;
  rateLimitPerSec?: number;
}

export interface Workers {
  ingest: Worker<IngestJobData, IngestResult>;
  discover: Worker<DiscoverJobData>;
  close(): Promise<void>;
}

export function startWorkers(deps: WorkerDeps): Workers {
  const { connection, pool, sources, queues, log } = deps;
  const common = {
    connection,
    prefix: config.QUEUE_PREFIX,
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
        computeBackoff(attemptsMade, err),
    },
  };

  /**
   * Error policy shared by both queues:
   *   rate limited → pause the whole queue for Retry-After; does NOT consume an attempt
   *   transient    → throw; BullMQ retries with jittered backoff
   *   permanent    → UnrecoverableError; no retries
   *   final failure (permanent or attempts exhausted) → row in ingestion_failures (DLQ)
   */
  async function withPolicy<T>(
    queue: string,
    job: Job<{ source: string; externalId?: string }>,
    worker: () => Worker,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));

      if (e instanceof RateLimitedError) {
        metrics.rateLimited.inc({ source: job.data.source });
        log.warn({ queue, jobId: job.id, retryAfterMs: e.retryAfterMs }, 'rate limited by source; pausing queue');
        await worker().rateLimit(e.retryAfterMs);
        throw Worker.RateLimitError();
      }

      const retryable = isRetryable(e);
      const attempt = job.attemptsMade + 1;
      const final = !retryable || attempt >= (job.opts.attempts ?? 1);
      const errorClass = classify(e);
      metrics.jobFailures.inc({ queue, error_class: errorClass, final: String(final) });
      log[final ? 'error' : 'warn'](
        { queue, jobId: job.id, source: job.data.source, externalId: job.data.externalId, attempt, errorClass, err: e.message },
        final ? 'job failed permanently → dead-letter' : 'job attempt failed; will retry',
      );

      if (final) {
        await recordFailure(pool, {
          queue,
          source: job.data.source,
          externalId: job.data.externalId ?? null,
          queueJobId: job.id ?? null,
          errorClass,
          errorMessage: e.message,
          attempts: attempt,
          payload: job.data,
        });
      }
      if (!retryable) throw new UnrecoverableError(`${errorClass}: ${e.message}`);
      throw e;
    }
  }

  const ingest: Worker<IngestJobData, IngestResult> = new Worker<IngestJobData, IngestResult>(
    QUEUE.ingest,
    (job) =>
      withPolicy(QUEUE.ingest, job, () => ingest, async () => {
        const end = metrics.ingestDuration.startTimer({ source: job.data.source });
        const result = await ingestItem({ pool, sources, log }, job.data);
        end();
        metrics.itemsIngested.inc({ source: result.source, outcome: result.outcome });
        log.debug({ jobId: job.id, ...result }, 'item ingested');
        return result;
      }),
    {
      ...common,
      concurrency: deps.concurrency ?? config.INGEST_CONCURRENCY,
      limiter: { max: deps.rateLimitPerSec ?? config.INGEST_RATE_LIMIT_PER_SEC, duration: 1000 },
    },
  );

  const discover: Worker<DiscoverJobData> = new Worker<DiscoverJobData>(
    QUEUE.discover,
    (job) =>
      withPolicy(QUEUE.discover, job, () => discover, async () => {
        const source = sources.get(job.data.source);
        const found = await source.discover(job.data.scope, { limit: job.data.limit });
        const jobs = await enqueueIngest(
          queues.ingest,
          found.map((f) => ({ source: source.name, externalId: f.externalId, hints: f.hints })),
          job.data.force ?? false,
        );
        log.info({ scope: job.data.scope, discovered: found.length }, 'discovery enqueued items');
        return { discovered: found.length, enqueued: jobs.length };
      }),
    { ...common, concurrency: 2 },
  );

  for (const w of [ingest, discover]) {
    w.on('error', (err) => log.error({ err, worker: w.name }, 'worker error'));
  }

  return {
    ingest,
    discover,
    async close() {
      await Promise.all([ingest.close(), discover.close()]);
    },
  };
}
