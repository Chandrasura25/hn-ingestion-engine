-- Canonical store: one row per (source, external_id). Never duplicated.
CREATE TABLE posts (
  id                 bigserial PRIMARY KEY,
  source             text        NOT NULL,
  external_id        text        NOT NULL,
  kind               text        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('active', 'deleted', 'dead')),
  title              text,
  body               text,
  url                text,
  author             text,
  parent_external_id text,
  score              integer,
  published_at       timestamptz,
  content_hash       text        NOT NULL,
  version            integer     NOT NULL DEFAULT 1,
  quality_issues     text[]      NOT NULL DEFAULT '{}',
  raw                jsonb       NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_fetched_at    timestamptz NOT NULL,
  last_changed_at    timestamptz NOT NULL DEFAULT now(),
  search             tsvector GENERATED ALWAYS AS (
                       to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
                     ) STORED,
  UNIQUE (source, external_id)
);
CREATE INDEX posts_search_idx ON posts USING gin (search);
CREATE INDEX posts_kind_idx   ON posts (kind, id DESC);

-- Previous versions of a post, written whenever content_hash changes.
CREATE TABLE post_versions (
  id           bigserial PRIMARY KEY,
  post_id      bigint      NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  version      integer     NOT NULL,
  content_hash text        NOT NULL,
  kind         text        NOT NULL,
  status       text        NOT NULL,
  title        text,
  body         text,
  url          text,
  raw          jsonb       NOT NULL,
  valid_from   timestamptz NOT NULL,
  valid_to     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, version)
);

-- Structured job data derived from posts. Removed when the post is deleted upstream.
CREATE TABLE job_postings (
  post_id       bigint PRIMARY KEY REFERENCES posts (id) ON DELETE CASCADE,
  origin        text    NOT NULL CHECK (origin IN ('yc_jobs', 'who_is_hiring')),
  company       text,
  role          text,
  location      text,
  remote        boolean,
  salary        text,
  yc_batch      text,
  emails        jsonb   NOT NULL DEFAULT '[]',
  linkedin_urls text[]  NOT NULL DEFAULT '{}',
  links         text[]  NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_postings_remote_idx ON job_postings (remote);

-- Cache of public author profiles (HN "about" field), used for contact enrichment.
CREATE TABLE authors (
  source          text NOT NULL,
  handle          text NOT NULL,
  about           text,
  karma           integer,
  created_at      timestamptz,
  emails          jsonb  NOT NULL DEFAULT '[]',
  linkedin_urls   text[] NOT NULL DEFAULT '{}',
  raw             jsonb  NOT NULL,
  last_fetched_at timestamptz NOT NULL,
  PRIMARY KEY (source, handle)
);

-- Dead-letter table: jobs that exhausted retries or failed permanently.
CREATE TABLE ingestion_failures (
  id            bigserial PRIMARY KEY,
  queue         text        NOT NULL,
  source        text        NOT NULL,
  external_id   text,
  queue_job_id  text,
  error_class   text        NOT NULL,
  error_message text        NOT NULL,
  attempts      integer     NOT NULL,
  payload       jsonb       NOT NULL,
  failed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX ingestion_failures_open_idx
  ON ingestion_failures (source, external_id) WHERE resolved_at IS NULL;
