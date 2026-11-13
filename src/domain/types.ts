export type PostKind = 'story' | 'job' | 'comment' | 'poll' | 'pollopt' | 'unknown';
export type PostStatus = 'active' | 'deleted' | 'dead';
export type JobOrigin = 'yc_jobs' | 'who_is_hiring';

/** Context discovered upstream that the item itself doesn't carry. */
export interface IngestHints {
  jobOrigin?: JobOrigin;
  threadId?: string;
}

export interface RawItem {
  externalId: string;
  payload: unknown;
  fetchedAt: Date;
}

export interface RawAuthor {
  handle: string;
  about: string | null;
  karma: number | null;
  createdAt: Date | null;
  payload: unknown;
}

export interface NormalizedPost {
  source: string;
  externalId: string;
  kind: PostKind;
  status: PostStatus;
  title: string | null;
  body: string | null;
  url: string | null;
  author: string | null;
  parentExternalId: string | null;
  score: number | null;
  publishedAt: Date | null;
  /** Fields that were missing or malformed but didn't stop ingestion. */
  qualityIssues: string[];
  /** Hash of the meaningful content. Score/kids are excluded so votes don't create versions. */
  contentHash: string;
  raw: unknown;
}

export interface EmailContact {
  address: string;
  kind: 'personal' | 'work';
  origin: 'post' | 'author_profile';
}

export interface JobDetails {
  origin: JobOrigin;
  company: string | null;
  role: string | null;
  location: string | null;
  remote: boolean | null;
  salary: string | null;
  ycBatch: string | null;
  emails: EmailContact[];
  linkedinUrls: string[];
  links: string[];
  roleTags: string[];
  remoteScope: string | null;
  remoteRegions: string[];
  visaSponsorship: boolean | null;
}

export interface NormalizedItem {
  post: NormalizedPost;
  job: JobDetails | null;
}

export interface DiscoveredItem {
  externalId: string;
  hints?: IngestHints;
}

export interface SourceAdapter {
  readonly name: string;
  /** Throws a SourceError subclass on failure; never returns partial garbage silently. */
  fetchItem(externalId: string): Promise<RawItem>;
  normalize(raw: RawItem, hints: IngestHints): NormalizedItem;
  discover(scope: string, opts: { limit?: number }): Promise<DiscoveredItem[]>;
  fetchAuthor?(handle: string): Promise<RawAuthor>;
}
