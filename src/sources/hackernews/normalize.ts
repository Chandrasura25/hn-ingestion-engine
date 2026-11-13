import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InvalidPayloadError } from '../../domain/errors.js';
import type {
  IngestHints,
  JobOrigin,
  NormalizedItem,
  NormalizedPost,
  PostKind,
  PostStatus,
  RawItem,
} from '../../domain/types.js';
import { decodeEntities, htmlToText } from '../../normalize/html.js';
import { buildJobDetails } from '../../normalize/jobs.js';

const ID = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((s) => Number(s)),
]);
const KINDS = new Set<PostKind>(['story', 'job', 'comment', 'poll', 'pollopt']);

/** Lenient field read: a malformed field becomes null + a recorded issue instead of failing the item. */
function field<T>(
  o: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
  issues: string[],
): T | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  issues.push(`invalid_${key}`);
  return undefined;
}

export function contentHash(p: Omit<NormalizedPost, 'contentHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([p.kind, p.status, p.title, p.body, p.url, p.author, p.parentExternalId]),
    )
    .digest('hex');
}

/**
 * Shared by the real HN source and the chaos source (which emits HN-shaped payloads).
 * Hard failures (not an object, missing/mismatched id) throw InvalidPayloadError → DLQ.
 * Soft failures (bad types, missing fields) are stored with `qualityIssues`.
 */
export function normalizeHnItem(
  source: string,
  raw: RawItem,
  hints: IngestHints = {},
): NormalizedItem {
  const p = raw.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    throw new InvalidPayloadError('payload is not an object');
  }
  const o = p as Record<string, unknown>;
  const id = ID.safeParse(o.id);
  if (!id.success) throw new InvalidPayloadError('payload has no valid id');
  if (String(id.data) !== raw.externalId) {
    throw new InvalidPayloadError(`id mismatch: requested ${raw.externalId}, got ${id.data}`);
  }

  const issues: string[] = [];
  const type = field(o, 'type', z.string(), issues);
  const by = field(o, 'by', z.string().min(1), issues);
  const time = field(o, 'time', z.number().int().positive(), issues);
  const title = field(o, 'title', z.string(), issues);
  const text = field(o, 'text', z.string(), issues);
  const url = field(o, 'url', z.string().url(), issues);
  const score = field(o, 'score', z.number().int(), issues);
  const parent = field(o, 'parent', ID, issues);
  const deleted = field(o, 'deleted', z.boolean(), issues) ?? false;
  const dead = field(o, 'dead', z.boolean(), issues) ?? false;

  let kind: PostKind = 'unknown';
  if (type === undefined) issues.push('missing_type');
  else if (KINDS.has(type as PostKind)) kind = type as PostKind;
  else issues.push('unknown_type');

  const status: PostStatus = deleted ? 'deleted' : dead ? 'dead' : 'active';
  if (status === 'active') {
    if (!by && !issues.includes('invalid_by')) issues.push('missing_by');
    if (!time && !issues.includes('invalid_time')) issues.push('missing_time');
  }

  const base: Omit<NormalizedPost, 'contentHash'> = {
    source,
    externalId: raw.externalId,
    kind,
    status,
    title: title ? decodeEntities(title) : null,
    body: text ? htmlToText(text) : null,
    url: url ?? null,
    author: by ?? null,
    parentExternalId: parent !== undefined ? String(parent) : null,
    score: score ?? null,
    publishedAt: time ? new Date(time * 1000) : null,
    qualityIssues: issues,
    raw: p,
  };
  const post: NormalizedPost = { ...base, contentHash: contentHash(base) };

  let origin: JobOrigin | null = null;
  if (kind === 'job') origin = 'yc_jobs';
  else if (hints.jobOrigin) origin = hints.jobOrigin;

  const job =
    origin && status === 'active'
      ? buildJobDetails(origin, post.title, post.body, post.url)
      : null;
  return { post, job };
}
