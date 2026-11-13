import { z } from 'zod';
import { config } from '../../config.js';
import {
  InvalidPayloadError,
  NotFoundError,
  PermanentSourceError,
  RateLimitedError,
  TransientSourceError,
} from '../../domain/errors.js';
import type {
  DiscoveredItem,
  IngestHints,
  NormalizedItem,
  RawAuthor,
  RawItem,
  SourceAdapter,
} from '../../domain/types.js';
import { metrics } from '../../metrics.js';
import { normalizeHnItem } from './normalize.js';

const IdList = z.array(z.number().int());
const HiringUser = z.object({ submitted: z.array(z.number().int()).default([]) });
const Thread = z.object({ title: z.string().optional(), kids: z.array(z.number().int()).default([]) });
const User = z.object({
  id: z.string(),
  about: z.string().optional(),
  karma: z.number().optional(),
  created: z.number().optional(),
});

const LIST_SCOPES = ['topstories', 'newstories', 'beststories', 'askstories', 'showstories'];

export function parseRetryAfter(header: string | null, fallbackMs = 5000): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? fallbackMs : Math.max(0, at - Date.now());
}

/**
 * Official Hacker News Firebase API (https://github.com/HackerNews/API).
 * Public, read-only, no auth. We still rate-limit ourselves to be a good citizen.
 */
export class HackerNewsSource implements SourceAdapter {
  readonly name = 'hackernews';

  constructor(
    private readonly baseUrl = config.HN_BASE_URL,
    private readonly timeoutMs = config.FETCH_TIMEOUT_MS,
  ) {}

  private async getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'user-agent': 'hn-ingestion-engine/0.1 (portfolio project)' },
      });
    } catch (err) {
      metrics.sourceRequests.inc({ source: this.name, outcome: 'network_error' });
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new TransientSourceError(`network error on ${path}: ${msg}`);
    }
    metrics.sourceRequests.inc({ source: this.name, outcome: String(res.status) });

    if (res.status === 429) {
      throw new RateLimitedError(parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status >= 500 || res.status === 408) {
      throw new TransientSourceError(`HTTP ${res.status} on ${path}`);
    }
    if (res.status === 404) throw new NotFoundError(`HTTP 404 on ${path}`);
    if (!res.ok) throw new PermanentSourceError(`HTTP ${res.status} on ${path}`);

    try {
      return await res.json();
    } catch {
      // Truncated/garbled bodies are usually a dropped connection: retry.
      throw new TransientSourceError(`unparseable JSON body on ${path}`);
    }
  }

  async fetchItem(externalId: string): Promise<RawItem> {
    if (!/^\d+$/.test(externalId)) {
      throw new InvalidPayloadError(`"${externalId}" is not a valid HN item id`);
    }
    const payload = await this.getJson(`/item/${externalId}.json`);
    const fetchedAt = new Date();
    // HN answers 200 + `null` for ids that don't exist.
    if (payload === null) throw new NotFoundError(`HN item ${externalId} does not exist`);
    return { externalId, payload, fetchedAt };
  }

  normalize(raw: RawItem, hints: IngestHints): NormalizedItem {
    return normalizeHnItem(this.name, raw, hints);
  }

  async fetchAuthor(handle: string): Promise<RawAuthor> {
    const payload = await this.getJson(`/user/${encodeURIComponent(handle)}.json`);
    if (payload === null) throw new NotFoundError(`HN user ${handle} does not exist`);
    const u = User.safeParse(payload);
    if (!u.success) throw new InvalidPayloadError(`malformed HN user ${handle}`);
    return {
      handle: u.data.id,
      about: u.data.about ?? null,
      karma: u.data.karma ?? null,
      createdAt: u.data.created ? new Date(u.data.created * 1000) : null,
      // `submitted` can be tens of thousands of ids; don't keep it.
      payload: { id: u.data.id, about: u.data.about, karma: u.data.karma, created: u.data.created },
    };
  }

  /**
   * Scopes:
   *   jobstories              YC company job posts (type=job)
   *   whoishiring             latest "Ask HN: Who is hiring?" thread → each top-level comment
   *   whoishiring:<threadId>  a specific month's thread
   *   topstories|newstories|beststories|askstories|showstories
   */
  async discover(scope: string, opts: { limit?: number } = {}): Promise<DiscoveredItem[]> {
    const limit = opts.limit ?? Infinity;

    if (scope === 'jobstories') {
      const ids = this.parse(IdList, await this.getJson('/jobstories.json'), scope);
      return ids.slice(0, limit).map((id) => ({
        externalId: String(id),
        hints: { jobOrigin: 'yc_jobs' as const },
      }));
    }

    if (scope === 'whoishiring' || scope.startsWith('whoishiring:')) {
      const threadId = scope.includes(':')
        ? scope.split(':')[1]!
        : await this.latestHiringThreadId();
      if (!/^\d+$/.test(threadId)) throw new InvalidPayloadError(`bad thread id "${threadId}"`);
      const thread = this.parse(Thread, await this.getJson(`/item/${threadId}.json`), scope);
      const hints: IngestHints = { jobOrigin: 'who_is_hiring', threadId };
      return [
        { externalId: threadId },
        ...thread.kids.slice(0, limit).map((id) => ({ externalId: String(id), hints })),
      ];
    }

    if (LIST_SCOPES.includes(scope)) {
      const ids = this.parse(IdList, await this.getJson(`/${scope}.json`), scope);
      return ids.slice(0, limit).map((id) => ({ externalId: String(id) }));
    }

    throw new PermanentSourceError(`unknown hackernews scope "${scope}"`);
  }

  private async latestHiringThreadId(): Promise<string> {
    const user = this.parse(HiringUser, await this.getJson('/user/whoishiring.json'), 'whoishiring');
    // The account posts 3 threads a month; newest first. Find the hiring one.
    for (const id of user.submitted.slice(0, 12)) {
      const item = Thread.safeParse(await this.getJson(`/item/${id}.json`));
      if (item.success && /who is hiring/i.test(item.data.title ?? '')) return String(id);
    }
    throw new NotFoundError('no recent "Who is hiring?" thread found');
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value);
    if (!r.success) throw new InvalidPayloadError(`unexpected response shape for ${what}`);
    return r.data;
  }
}
