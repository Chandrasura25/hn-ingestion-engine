-- Role categories (founding, backend, fullstack, frontend, ai, software) for relevance filtering.
ALTER TABLE job_postings ADD COLUMN role_tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX job_postings_role_tags_idx ON job_postings USING gin (role_tags);
