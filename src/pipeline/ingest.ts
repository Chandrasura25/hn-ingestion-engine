import { config } from '../config.js';
import {
  deleteJobPosting,
  getFreshAuthor,
  resolveFailures,
  saveAuthor,
  upsertJobPosting,
  upsertPost,
  type CachedAuthor,
  type UpsertOutcome,
} from '../db/repository.js';
import { withTransaction, type Pool } from '../db/pool.js';
import type { EmailContact, IngestHints, JobDetails, SourceAdapter } from '../domain/types.js';
import { extractEmails, extractLinkedIn } from '../normalize/contacts.js';
import { htmlToText } from '../normalize/html.js';
import type { Logger } from '../logger.js';
import type { SourceRegistry } from '../sources/registry.js';

export interface IngestJobData {
  source: string;
  externalId: string;
  hints?: IngestHints;
}

export interface IngestResult {
  source: string;
  externalId: string;
  outcome: UpsertOutcome;
  postId: string;
  version: number;
  isJob: boolean;
  authorEnriched: boolean;
  qualityIssues: string[];
}

export interface PipelineDeps {
  pool: Pool;
  sources: SourceRegistry;
  log: Logger;
}

/**
 * fetch → normalize → (best-effort author enrichment) → transactional persist.
 * Network calls happen before the transaction so no DB locks are held while waiting on upstream.
 */
export async function ingestItem(deps: PipelineDeps, data: IngestJobData): Promise<IngestResult> {
  const source = deps.sources.get(data.source);
  const raw = await source.fetchItem(data.externalId);
  const { post, job } = source.normalize(raw, data.hints ?? {});

  let author: CachedAuthor | null = null;
  if (job && post.author && source.fetchAuthor) {
    author = await authorContacts(deps, source, post.author).catch((err: unknown) => {
      deps.log.warn(
        { source: source.name, author: post.author, err: (err as Error).message },
        'author enrichment failed; continuing with post contacts only',
      );
      return null;
    });
  }

  return withTransaction(deps.pool, async (c) => {
    const res = await upsertPost(c, post, raw.fetchedAt);
    if (res.outcome !== 'stale') {
      if (job) await upsertJobPosting(c, res.postId, mergeContacts(job, author));
      else if (post.status !== 'active') await deleteJobPosting(c, res.postId);
      await resolveFailures(c, post.source, post.externalId);
    }
    return {
      source: post.source,
      externalId: post.externalId,
      outcome: res.outcome,
      postId: res.postId,
      version: res.version,
      isJob: job !== null,
      authorEnriched: author !== null,
      qualityIssues: post.qualityIssues,
    };
  });
}

async function authorContacts(
  deps: PipelineDeps,
  source: SourceAdapter,
  handle: string,
): Promise<CachedAuthor> {
  const cached = await getFreshAuthor(deps.pool, source.name, handle, config.AUTHOR_CACHE_HOURS);
  if (cached) return cached;
  const author = await source.fetchAuthor!(handle);
  const about = author.about ? htmlToText(author.about) : '';
  const contacts: CachedAuthor = {
    emails: extractEmails(about),
    linkedinUrls: extractLinkedIn(about),
  };
  await saveAuthor(deps.pool, source.name, author, contacts);
  return contacts;
}

/** Post contacts win over profile contacts; duplicates collapse. */
export function mergeContacts(job: JobDetails, author: CachedAuthor | null): JobDetails {
  if (!author) return job;
  const emails = new Map<string, EmailContact>(job.emails.map((e) => [e.address, e]));
  for (const e of author.emails) {
    if (!emails.has(e.address)) emails.set(e.address, { ...e, origin: 'author_profile' });
  }
  return {
    ...job,
    emails: [...emails.values()],
    linkedinUrls: [...new Set([...job.linkedinUrls, ...author.linkedinUrls])],
  };
}
