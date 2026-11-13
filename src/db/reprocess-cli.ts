/**
 * Re-derive job data from the raw payloads already stored, without touching the upstream.
 * Use after improving the parser: `npm run reprocess`.
 * Author-profile contacts come from the `authors` cache, so nothing enriched is lost.
 */
import type { JobOrigin, RawItem } from '../domain/types.js';
import { logger } from '../logger.js';
import { extractEmails } from '../normalize/contacts.js';
import { mergeContacts } from '../pipeline/ingest.js';
import { normalizeHnItem } from '../sources/hackernews/normalize.js';
import { createPool, withTransaction } from './pool.js';
import { upsertJobPosting } from './repository.js';

const pool = createPool();
try {
  const { rows } = await pool.query<{
    id: string; source: string; external_id: string; raw: unknown; last_fetched_at: Date;
    origin: JobOrigin; a_emails: ReturnType<typeof extractEmails> | null; a_linkedin: string[] | null;
  }>(
    `SELECT p.id, p.source, p.external_id, p.raw, p.last_fetched_at, j.origin,
            a.emails AS a_emails, a.linkedin_urls AS a_linkedin
       FROM job_postings j
       JOIN posts p ON p.id = j.post_id
       LEFT JOIN authors a ON a.source = p.source AND a.handle = p.author`,
  );
  let updated = 0;
  await withTransaction(pool, async (c) => {
    for (const r of rows) {
      const raw: RawItem = { externalId: r.external_id, payload: r.raw, fetchedAt: r.last_fetched_at };
      const { job } = normalizeHnItem(r.source, raw, { jobOrigin: r.origin });
      if (!job) continue;
      const author = r.a_emails ? { emails: r.a_emails, linkedinUrls: r.a_linkedin ?? [] } : null;
      await upsertJobPosting(c, r.id, mergeContacts(job, author));
      updated++;
    }
  });
  logger.info({ updated }, 'job postings reprocessed from stored raw payloads');
} catch (err) {
  logger.error({ err }, 'reprocess failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
