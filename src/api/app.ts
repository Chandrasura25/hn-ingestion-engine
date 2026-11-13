import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import {
  getPostWithHistory,
  listFailures,
  searchJobs,
  searchPosts,
  stats,
} from '../db/queries.js';
import type { Logger } from '../logger.js';
import { metrics, registry } from '../metrics.js';
import { enqueueDiscover, enqueueIngest, QUEUE, type Queues } from '../queue/queues.js';
import { ROLE_TAGS } from '../normalize/roles.js';

export interface AppDeps {
  pool: Pool;
  redis: Redis;
  queues: Queues;
  log: Logger;
  sourceNames: string[];
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');
const limitParam = z.coerce.number().int().min(1).max(200).default(50);
const cursorParam = z.string().regex(/^\d+$/);
const JOB_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'completed', 'failed'] as const;

export function buildApp(deps: AppDeps) {
  const { pool, redis, queues } = deps;
  const app = Fastify({ loggerInstance: deps.log });
  const sourceParam = z.enum(deps.sourceNames as [string, ...string[]]).default('hackernews');

  /** Minimal read-only viewer over GET /jobs. */
  const uiHtml = readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(uiHtml));

  app.get('/health', async (_req, reply) => {
    const [db, rd] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const ok = db.status === 'fulfilled' && rd.status === 'fulfilled';
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      redis: rd.status === 'fulfilled' ? 'up' : 'down',
    });
  });

  const IngestBody = z.union([
    z.object({
      source: sourceParam,
      ids: z.array(z.union([z.string(), z.number()]).transform(String)).min(1).max(5000),
      force: z.boolean().default(false),
    }),
    z.object({
      source: sourceParam,
      scope: z.string().min(1),
      limit: z.number().int().positive().max(5000).optional(),
      force: z.boolean().default(false),
    }),
  ]);

  /** Enqueue specific ids, or a discovery scope (jobstories, whoishiring, ...). Returns 202. */
  app.post('/ingest', async (req, reply) => {
    const body = parse(IngestBody, req.body ?? {});
    if ('ids' in body) {
      const jobs = await enqueueIngest(
        queues.ingest,
        body.ids.map((externalId) => ({ source: body.source, externalId })),
        body.force,
      );
      return reply.code(202).send({ queue: QUEUE.ingest, jobs });
    }
    const jobId = await enqueueDiscover(queues.discover, body);
    return reply.code(202).send({ queue: QUEUE.discover, jobId });
  });

  app.get('/queues/:queue/jobs/:jobId', async (req) => {
    const { queue, jobId } = parse(
      z.object({ queue: z.enum([QUEUE.ingest, QUEUE.discover]), jobId: z.string() }),
      req.params,
    );
    const job = await (queue === QUEUE.ingest ? queues.ingest : queues.discover).getJob(jobId);
    if (!job) throw new HttpError(404, 'job not found (it may have expired from the queue)');
    return {
      id: job.id,
      state: await job.getState(),
      data: job.data,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
      result: job.returnvalue ?? null,
      createdAt: new Date(job.timestamp),
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    };
  });

  app.get('/stats', async () => {
    const [ingest, discover, db] = await Promise.all([
      queues.ingest.getJobCounts(...JOB_STATES),
      queues.discover.getJobCounts(...JOB_STATES),
      stats(pool),
    ]);
    return { queues: { ingest, discover }, store: db };
  });

  app.get('/posts', async (req) => {
    const q = parse(
      z.object({
        q: z.string().min(1).optional(),
        kind: z.string().optional(),
        source: z.string().optional(),
        before: cursorParam.optional(),
        limit: limitParam,
      }),
      req.query,
    );
    const items = await searchPosts(pool, q);
    return { items, nextBefore: items.length === q.limit ? items.at(-1)?.id : null };
  });

  app.get('/posts/:source/:externalId', async (req) => {
    const { source, externalId } = req.params as { source: string; externalId: string };
    const post = await getPostWithHistory(pool, source, externalId);
    if (!post) throw new HttpError(404, 'post not found');
    return post;
  });

  const JobQuery = z.object({
    q: z.string().min(1).optional(),
    remote: boolParam.optional(),
    has_email: boolParam.optional(),
    has_linkedin: boolParam.optional(),
    origin: z.enum(['yc_jobs', 'who_is_hiring']).optional(),
    tags: z
      .string()
      .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
      .pipe(z.array(z.enum(ROLE_TAGS)))
      .optional(),
    open_to: z.enum(['nigeria']).optional(),
    include_unstated: boolParam.optional(),
    include_visa: boolParam.optional(),
    /** ISO date/time; the UI sends the viewer's local midnight for "today". */
    since: z.coerce.date().optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: limitParam,
  });
  type JobQueryT = z.infer<typeof JobQuery>;
  const toFilter = (q: Omit<JobQueryT, 'limit' | 'page'>) => ({
    ...q,
    hasEmail: q.has_email,
    hasLinkedin: q.has_linkedin,
    openTo: q.open_to,
    includeUnstated: q.include_unstated,
    includeVisa: q.include_visa,
  });

  app.get('/jobs', async (req) => {
    const q = parse(JobQuery, req.query);
    const { items, total } = await searchJobs(pool, { ...toFilter(q), page: q.page, limit: q.limit });
    return { items, total, page: q.page, pageSize: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) };
  });

  /** Same filters as /jobs, as a spreadsheet-friendly CSV (up to 5000 rows). */
  app.get('/jobs.csv', async (req, reply) => {
    const q = parse(JobQuery.omit({ limit: true, page: true }), req.query);
    const { items: rows } = await searchJobs(pool, { ...toFilter(q), limit: 5000 });
    const cols = ['hn_url', 'company', 'role', 'role_tags', 'location', 'remote', 'remote_scope', 'remote_regions', 'visa_sponsorship', 'salary', 'yc_batch', 'emails', 'linkedin_urls', 'links', 'author', 'published_at'];
    const cell = (v: unknown): string => {
      const s =
        v == null ? ''
        : v instanceof Date ? v.toISOString()
        : Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x && 'address' in x ? x.address : String(x))).join(' ')
        : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="hn-jobs.csv"')
      .send(csv);
  });

  app.get('/failures', async (req) => {
    const q = parse(z.object({ all: boolParam.default(false), limit: limitParam }), req.query);
    return { items: await listFailures(pool, !q.all, q.limit) };
  });

  /** Replay a dead-lettered job. The entry is resolved automatically once the item ingests. */
  app.post('/failures/:id/retry', async (req, reply) => {
    const { id } = parse(z.object({ id: cursorParam }), req.params);
    const { rows } = await pool.query('SELECT * FROM ingestion_failures WHERE id = $1', [id]);
    const f = rows[0];
    if (!f) throw new HttpError(404, 'failure not found');
    if (f.queue === QUEUE.discover) {
      const jobId = await enqueueDiscover(queues.discover, f.payload);
      await pool.query('UPDATE ingestion_failures SET resolved_at = now() WHERE id = $1', [id]);
      return reply.code(202).send({ queue: QUEUE.discover, jobId });
    }
    const jobs = await enqueueIngest(queues.ingest, [f.payload], true);
    return reply.code(202).send({ queue: QUEUE.ingest, jobs });
  });

  app.get('/metrics', async (_req, reply) => {
    for (const [name, q] of [[QUEUE.ingest, queues.ingest], [QUEUE.discover, queues.discover]] as const) {
      const counts = await q.getJobCounts(...JOB_STATES);
      for (const [state, n] of Object.entries(counts)) metrics.queueDepth.set({ queue: name, state }, n);
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });

  return app;
}
