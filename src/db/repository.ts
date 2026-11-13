import type { EmailContact, JobDetails, NormalizedPost, RawAuthor } from '../domain/types.js';
import type { Pool, PoolClient } from './pool.js';

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale';

export interface UpsertResult {
  outcome: UpsertOutcome;
  postId: string;
  version: number;
}

interface CurrentRow {
  id: string;
  version: number;
  content_hash: string;
  last_fetched_at: Date;
  last_changed_at: Date;
  kind: string;
  status: string;
  title: string | null;
  body: string | null;
  url: string | null;
  raw: unknown;
}

/**
 * Idempotent, concurrency-safe upsert.
 *
 * 1. INSERT … ON CONFLICT DO NOTHING: two workers racing on a brand-new item can't both insert.
 * 2. Otherwise lock the row (FOR UPDATE) and compare:
 *    - older fetch than what we hold → 'stale', ignored (out-of-order delivery)
 *    - same content hash            → 'unchanged', only volatile fields (score) refreshed
 *    - different hash               → snapshot old row into post_versions, bump version
 * Must run inside a transaction.
 */
export async function upsertPost(
  c: PoolClient,
  p: NormalizedPost,
  fetchedAt: Date,
): Promise<UpsertResult> {
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO posts (source, external_id, kind, status, title, body, url, author,
                        parent_external_id, score, published_at, content_hash, quality_issues,
                        raw, last_fetched_at, last_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id`,
    [
      p.source, p.externalId, p.kind, p.status, p.title, p.body, p.url, p.author,
      p.parentExternalId, p.score, p.publishedAt, p.contentHash, p.qualityIssues,
      JSON.stringify(p.raw), fetchedAt,
    ],
  );
  if (inserted.rows[0]) return { outcome: 'inserted', postId: inserted.rows[0].id, version: 1 };

  const { rows } = await c.query<CurrentRow>(
    `SELECT id, version, content_hash, last_fetched_at, last_changed_at,
            kind, status, title, body, url, raw
       FROM posts WHERE source = $1 AND external_id = $2 FOR UPDATE`,
    [p.source, p.externalId],
  );
  const cur = rows[0];
  if (!cur) throw new Error(`post ${p.source}/${p.externalId} vanished during upsert`);

  if (fetchedAt.getTime() < cur.last_fetched_at.getTime()) {
    return { outcome: 'stale', postId: cur.id, version: cur.version };
  }

  if (cur.content_hash === p.contentHash) {
    await c.query(
      `UPDATE posts SET score = $2, raw = $3, last_fetched_at = $4 WHERE id = $1`,
      [cur.id, p.score, JSON.stringify(p.raw), fetchedAt],
    );
    return { outcome: 'unchanged', postId: cur.id, version: cur.version };
  }

  await c.query(
    `INSERT INTO post_versions (post_id, version, content_hash, kind, status, title, body, url,
                                raw, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      cur.id, cur.version, cur.content_hash, cur.kind, cur.status, cur.title, cur.body, cur.url,
      JSON.stringify(cur.raw), cur.last_changed_at,
    ],
  );
  const updated = await c.query<{ version: number }>(
    `UPDATE posts SET kind = $2, status = $3, title = $4, body = $5, url = $6, author = $7,
            parent_external_id = $8, score = $9, published_at = $10, content_hash = $11,
            quality_issues = $12, raw = $13, last_fetched_at = $14, last_changed_at = now(),
            version = version + 1
      WHERE id = $1 RETURNING version`,
    [
      cur.id, p.kind, p.status, p.title, p.body, p.url, p.author, p.parentExternalId, p.score,
      p.publishedAt, p.contentHash, p.qualityIssues, JSON.stringify(p.raw), fetchedAt,
    ],
  );
  return { outcome: 'updated', postId: cur.id, version: updated.rows[0]!.version };
}

export async function upsertJobPosting(c: PoolClient, postId: string, job: JobDetails): Promise<void> {
  await c.query(
    `INSERT INTO job_postings (post_id, origin, company, role, location, remote, salary, yc_batch,
                               emails, linkedin_urls, links, role_tags, remote_scope,
                               remote_regions, visa_sponsorship, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (post_id) DO UPDATE SET
       origin = EXCLUDED.origin, company = EXCLUDED.company, role = EXCLUDED.role,
       location = EXCLUDED.location, remote = EXCLUDED.remote, salary = EXCLUDED.salary,
       yc_batch = EXCLUDED.yc_batch, emails = EXCLUDED.emails,
       linkedin_urls = EXCLUDED.linkedin_urls, links = EXCLUDED.links,
       role_tags = EXCLUDED.role_tags, remote_scope = EXCLUDED.remote_scope,
       remote_regions = EXCLUDED.remote_regions,
       visa_sponsorship = EXCLUDED.visa_sponsorship, updated_at = now()`,
    [
      postId, job.origin, job.company, job.role, job.location, job.remote, job.salary, job.ycBatch,
      JSON.stringify(job.emails), job.linkedinUrls, job.links, job.roleTags,
      job.remoteScope, job.remoteRegions, job.visaSponsorship,
    ],
  );
}

export async function deleteJobPosting(c: PoolClient, postId: string): Promise<void> {
  await c.query('DELETE FROM job_postings WHERE post_id = $1', [postId]);
}

/** A successful ingest closes any open dead-letter entries for the same item. */
export async function resolveFailures(c: PoolClient, source: string, externalId: string): Promise<void> {
  await c.query(
    `UPDATE ingestion_failures SET resolved_at = now()
      WHERE source = $1 AND external_id = $2 AND resolved_at IS NULL`,
    [source, externalId],
  );
}

export interface CachedAuthor {
  emails: Array<Omit<EmailContact, 'origin'>>;
  linkedinUrls: string[];
}

export async function getFreshAuthor(
  pool: Pool,
  source: string,
  handle: string,
  maxAgeHours: number,
): Promise<CachedAuthor | null> {
  const { rows } = await pool.query<{ emails: CachedAuthor['emails']; linkedin_urls: string[] }>(
    `SELECT emails, linkedin_urls FROM authors
      WHERE source = $1 AND handle = $2
        AND last_fetched_at > now() - make_interval(secs => $3)`,
    [source, handle, maxAgeHours * 3600],
  );
  const r = rows[0];
  return r ? { emails: r.emails, linkedinUrls: r.linkedin_urls } : null;
}

export async function saveAuthor(
  pool: Pool,
  source: string,
  author: RawAuthor,
  contacts: CachedAuthor,
): Promise<void> {
  await pool.query(
    `INSERT INTO authors (source, handle, about, karma, created_at, emails, linkedin_urls, raw,
                          last_fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (source, handle) DO UPDATE SET
       about = EXCLUDED.about, karma = EXCLUDED.karma, created_at = EXCLUDED.created_at,
       emails = EXCLUDED.emails, linkedin_urls = EXCLUDED.linkedin_urls, raw = EXCLUDED.raw,
       last_fetched_at = now()`,
    [
      source, author.handle, author.about, author.karma, author.createdAt,
      JSON.stringify(contacts.emails), contacts.linkedinUrls, JSON.stringify(author.payload),
    ],
  );
}

export interface FailureRecord {
  queue: string;
  source: string;
  externalId: string | null;
  queueJobId: string | null;
  errorClass: string;
  errorMessage: string;
  attempts: number;
  payload: unknown;
}

export async function recordFailure(pool: Pool, f: FailureRecord): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_failures (queue, source, external_id, queue_job_id, error_class,
                                     error_message, attempts, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      f.queue, f.source, f.externalId, f.queueJobId, f.errorClass, f.errorMessage.slice(0, 2000),
      f.attempts, JSON.stringify(f.payload),
    ],
  );
}
