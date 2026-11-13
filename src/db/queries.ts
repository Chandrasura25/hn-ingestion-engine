import type { Pool } from './pool.js';

export interface PostFilter {
  q?: string;
  kind?: string;
  source?: string;
  before?: string;
  limit: number;
}

export async function searchPosts(pool: Pool, f: PostFilter) {
  const { rows } = await pool.query(
    `SELECT id, source, external_id, kind, status, title, left(body, 500) AS body, url, author,
            score, published_at, version, quality_issues, last_changed_at
       FROM posts
      WHERE ($1::text IS NULL OR search @@ websearch_to_tsquery('english', $1))
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR source = $3)
        AND ($4::bigint IS NULL OR id < $4)
      ORDER BY id DESC
      LIMIT $5`,
    [f.q ?? null, f.kind ?? null, f.source ?? null, f.before ?? null, f.limit],
  );
  return rows;
}

export async function getPostWithHistory(pool: Pool, source: string, externalId: string) {
  const { rows } = await pool.query(
    `SELECT p.*, to_jsonb(j) - 'post_id' AS job
       FROM posts p LEFT JOIN job_postings j ON j.post_id = p.id
      WHERE p.source = $1 AND p.external_id = $2`,
    [source, externalId],
  );
  const post = rows[0];
  if (!post) return null;
  delete post.search;
  const versions = await pool.query(
    `SELECT version, content_hash, status, title, body, url, valid_from, valid_to
       FROM post_versions WHERE post_id = $1 ORDER BY version DESC`,
    [post.id],
  );
  return { ...post, versions: versions.rows };
}

export interface JobFilter {
  q?: string;
  remote?: boolean;
  hasEmail?: boolean;
  hasLinkedin?: boolean;
  origin?: string;
  /** Match jobs with ANY of these role tags. */
  tags?: string[];
  /** Remote jobs a candidate in this country can take (worldwide or matching region). */
  openTo?: 'nigeria';
  /** With openTo: also include remote jobs that don't say where (worth checking manually). */
  includeUnstated?: boolean;
  since?: Date;
  sort?: 'newest' | 'oldest';
  page?: number;
  limit: number;
}

const OPEN_TO_REGIONS: Record<NonNullable<JobFilter['openTo']>, string[]> = {
  nigeria: ['nigeria', 'africa', 'emea'],
};

export async function searchJobs(pool: Pool, f: JobFilter) {
  const { rows } = await pool.query(
    `SELECT p.id, p.source, p.external_id, p.title, left(p.body, 1500) AS body, p.url, p.author,
            p.published_at, j.origin, j.company, j.role, j.location, j.remote, j.salary,
            j.yc_batch, j.emails, j.linkedin_urls, j.links, j.role_tags, j.remote_scope,
            j.remote_regions, count(*) OVER () AS total_count,
            CASE WHEN p.source = 'hackernews'
                 THEN 'https://news.ycombinator.com/item?id=' || p.external_id END AS hn_url
       FROM job_postings j JOIN posts p ON p.id = j.post_id
      WHERE p.status = 'active'
        AND ($1::text IS NULL OR p.search @@ websearch_to_tsquery('english', $1))
        AND ($2::boolean IS NULL OR j.remote = $2)
        AND ($3::boolean IS NOT TRUE OR jsonb_array_length(j.emails) > 0)
        AND ($4::boolean IS NOT TRUE OR cardinality(j.linkedin_urls) > 0)
        AND ($5::text IS NULL OR j.origin = $5)
        AND ($6::timestamptz IS NULL OR p.published_at >= $6)
        AND ($8::text[] IS NULL OR j.role_tags && $8)
        AND ($9::text[] IS NULL OR (j.remote AND (
              j.remote_scope = 'worldwide'
              OR j.remote_regions && $9
              OR ($10::boolean AND j.remote_scope = 'unstated'))))
      ORDER BY ${f.sort === 'oldest' ? 'p.published_at ASC NULLS LAST, p.id ASC' : 'p.published_at DESC NULLS LAST, p.id DESC'}
      LIMIT $7 OFFSET $11`,
    [
      f.q ?? null, f.remote ?? null, f.hasEmail ?? null, f.hasLinkedin ?? null, f.origin ?? null,
      f.since ?? null, f.limit, f.tags?.length ? f.tags : null,
      f.openTo ? OPEN_TO_REGIONS[f.openTo] : null, f.includeUnstated ?? false,
      ((f.page ?? 1) - 1) * f.limit,
    ],
  );
  const total = rows[0] ? Number(rows[0].total_count) : 0;
  for (const r of rows) delete r.total_count;
  return { items: rows, total };
}

export async function listFailures(pool: Pool, unresolvedOnly: boolean, limit: number) {
  const { rows } = await pool.query(
    `SELECT * FROM ingestion_failures
      WHERE ($1::boolean IS NOT TRUE OR resolved_at IS NULL)
      ORDER BY id DESC LIMIT $2`,
    [unresolvedOnly, limit],
  );
  return rows;
}

export async function stats(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM posts)::int                                   AS posts,
       (SELECT count(*) FROM post_versions)::int                           AS versions,
       (SELECT count(*) FROM job_postings)::int                            AS jobs,
       (SELECT count(*) FROM job_postings WHERE jsonb_array_length(emails) > 0)::int AS jobs_with_email,
       (SELECT count(*) FROM job_postings WHERE cardinality(linkedin_urls) > 0)::int  AS jobs_with_linkedin,
       (SELECT count(*) FROM job_postings
         WHERE role_tags && '{founding,backend,fullstack,frontend,ai,software}')::int AS dev_jobs,
       (SELECT count(*) FROM posts WHERE cardinality(quality_issues) > 0)::int AS posts_with_quality_issues,
       (SELECT count(*) FROM ingestion_failures WHERE resolved_at IS NULL)::int AS open_failures`,
  );
  return rows[0];
}
