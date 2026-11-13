-- Where a remote job can be done from: worldwide | regional | unstated (NULL = not remote).
ALTER TABLE job_postings ADD COLUMN remote_scope text CHECK (remote_scope IN ('worldwide', 'regional', 'unstated'));
ALTER TABLE job_postings ADD COLUMN remote_regions text[] NOT NULL DEFAULT '{}';
CREATE INDEX job_postings_remote_regions_idx ON job_postings USING gin (remote_regions);
CREATE INDEX posts_published_idx ON posts (published_at DESC NULLS LAST, id DESC);
