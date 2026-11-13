import client from 'prom-client';

export const registry = client.register;

export const metrics = {
  sourceRequests: new client.Counter({
    name: 'source_requests_total',
    help: 'Upstream requests by source and outcome',
    labelNames: ['source', 'outcome'] as const,
  }),
  itemsIngested: new client.Counter({
    name: 'ingest_items_total',
    help: 'Items persisted, by outcome (inserted|updated|unchanged|stale)',
    labelNames: ['source', 'outcome'] as const,
  }),
  jobFailures: new client.Counter({
    name: 'ingest_job_failures_total',
    help: 'Failed job attempts; final=true means the job went to the dead-letter table',
    labelNames: ['queue', 'error_class', 'final'] as const,
  }),
  rateLimited: new client.Counter({
    name: 'ingest_rate_limited_total',
    help: 'Times a source told us to slow down',
    labelNames: ['source'] as const,
  }),
  ingestDuration: new client.Histogram({
    name: 'ingest_duration_seconds',
    help: 'Time to fetch, normalize and persist one item',
    labelNames: ['source'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  }),
  queueDepth: new client.Gauge({
    name: 'queue_jobs',
    help: 'Jobs per queue and state (sampled on scrape)',
    labelNames: ['queue', 'state'] as const,
  }),
};

let defaultsStarted = false;
export function collectDefaultMetrics(): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  client.collectDefaultMetrics();
}
