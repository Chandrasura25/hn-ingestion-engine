import { NotFoundError, RateLimitedError, TransientSourceError } from '../../domain/errors.js';
import type {
  DiscoveredItem,
  IngestHints,
  NormalizedItem,
  RawAuthor,
  RawItem,
  SourceAdapter,
} from '../../domain/types.js';
import { normalizeHnItem } from '../hackernews/normalize.js';

/**
 * A deliberately unreliable upstream that emits HN-shaped payloads.
 *
 * Behaviour is deterministic per item id (seeded), so tests can assert exact outcomes:
 *   - id % 17 == 0  → item never exists            (permanent: not_found → DLQ)
 *   - id % 23 == 0  → returns the wrong item       (permanent: invalid_payload → DLQ)
 *   - id % 5  == 0  → "Who is hiring" style job post with obfuscated email
 *   - id % 7  == 0  → partial record (missing time, `by` has wrong type)
 *   - id % 3  == 0  → edited after first successful fetch (tests versioning)
 *   - every id      → fails 0–3 times first (429 / timeout / 503 / truncated JSON)
 * Authors with an odd id are always unreachable, to prove enrichment is best-effort.
 */
export type FailureKind = 'rate_limited' | 'timeout' | 'server_error' | 'truncated_json';

export interface ChaosPlan {
  missing: boolean;
  corrupt: boolean;
  job: boolean;
  partial: boolean;
  edits: boolean;
  failures: FailureKind[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAILURE_KINDS: FailureKind[] = ['rate_limited', 'timeout', 'server_error', 'truncated_json'];

export function chaosPlan(id: number, seed = 42, maxFailures = 3): ChaosPlan {
  const rand = mulberry32(seed * 100_003 + id);
  const n = Math.floor(rand() * (maxFailures + 1));
  const failures = Array.from({ length: n }, () => FAILURE_KINDS[Math.floor(rand() * 4)]!);
  return {
    missing: id % 17 === 0,
    corrupt: id % 23 === 0 && id % 17 !== 0,
    job: id % 5 === 0,
    partial: id % 7 === 0,
    edits: id % 3 === 0,
    failures,
  };
}

export interface ChaosOptions {
  itemCount: number;
  seed?: number;
  maxFailuresPerItem?: number;
  rateLimitRetryMs?: number;
  latencyMs?: number;
}

export class ChaosSource implements SourceAdapter {
  readonly name = 'chaos';
  private readonly calls = new Map<number, number>();
  private readonly successes = new Map<number, number>();
  private lastTs = 0;

  constructor(private readonly opts: ChaosOptions) {}

  plan(id: number): ChaosPlan {
    return chaosPlan(id, this.opts.seed ?? 42, this.opts.maxFailuresPerItem ?? 3);
  }

  /** Strictly increasing timestamps so "which fetch is newer" is never ambiguous. */
  private now(): Date {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return new Date(this.lastTs);
  }

  async fetchItem(externalId: string): Promise<RawItem> {
    await new Promise((r) => setTimeout(r, this.opts.latencyMs ?? 2));
    const id = Number(externalId);
    const plan = this.plan(id);

    const call = (this.calls.get(id) ?? 0) + 1;
    this.calls.set(id, call);
    const failure = plan.failures[call - 1];
    if (failure === 'rate_limited') throw new RateLimitedError(this.opts.rateLimitRetryMs ?? 50);
    if (failure === 'timeout') throw new TransientSourceError('TimeoutError: upstream timed out');
    if (failure === 'server_error') throw new TransientSourceError('HTTP 503 Service Unavailable');
    if (failure === 'truncated_json') throw new TransientSourceError('unparseable JSON body');

    if (plan.missing || id < 1 || id > this.opts.itemCount) {
      throw new NotFoundError(`chaos item ${externalId} does not exist`);
    }

    const version = (this.successes.get(id) ?? 0) + 1;
    this.successes.set(id, version);
    const edited = plan.edits && version >= 2;
    const fetchedAt = this.now();

    const payload: Record<string, unknown> = {
      id: plan.corrupt ? id + 1 : id,
      by: plan.partial ? 12345 : `user${id}`,
      time: plan.partial ? undefined : 1_760_000_000 + id * 60,
      score: 10 + version, // changes every fetch; must NOT create a new version
      kids: Array.from({ length: version }, (_, i) => 1_000_000 + id * 10 + i),
    };
    if (plan.job) {
      payload.type = 'comment';
      payload.parent = 999_999;
      payload.text =
        `Acme ${id} | Senior Backend Engineer | Lagos, Nigeria | REMOTE | $120k-$160k` +
        `<p>We build ingestion pipelines${edited ? ' (UPDATED: now hiring 2 roles)' : ''}.` +
        `<p>Apply: jobs-${id} [at] example [dot] com or <a href="https:&#x2F;&#x2F;example.com&#x2F;jobs&#x2F;${id}">https:&#x2F;&#x2F;example.com&#x2F;jobs&#x2F;${id}</a>`;
    } else {
      payload.type = 'story';
      payload.title = `Chaos story ${id}${edited ? ' (edited)' : ''}`;
      payload.url = `https://example.com/story/${id}`;
    }
    return { externalId, payload, fetchedAt };
  }

  normalize(raw: RawItem, hints: IngestHints): NormalizedItem {
    return normalizeHnItem(this.name, raw, hints);
  }

  async fetchAuthor(handle: string): Promise<RawAuthor> {
    const n = Number(handle.replace(/^user/, ''));
    if (!Number.isFinite(n) || n % 2 === 1) {
      throw new TransientSourceError(`chaos author ${handle} unreachable`);
    }
    const about = `Hiring manager. linkedin.com/in/${handle}-example`;
    return { handle, about, karma: n, createdAt: new Date(1_600_000_000_000), payload: { id: handle, about } };
  }

  async discover(_scope: string, opts: { limit?: number } = {}): Promise<DiscoveredItem[]> {
    const n = Math.min(this.opts.itemCount, opts.limit ?? Infinity);
    return Array.from({ length: n }, (_, i) => {
      const id = i + 1;
      const hints: IngestHints | undefined = this.plan(id).job
        ? { jobOrigin: 'who_is_hiring', threadId: '999999' }
        : undefined;
      return { externalId: String(id), hints };
    });
  }
}
