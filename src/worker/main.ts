import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { logger } from '../logger.js';
import { collectDefaultMetrics, registry } from '../metrics.js';
import { createQueues } from '../queue/queues.js';
import { defaultSources } from '../sources/registry.js';
import { startWorkers } from './workers.js';

collectDefaultMetrics();
const log = logger.child({ component: 'worker' });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const pool = createPool();
const sources = defaultSources();
const queues = createQueues(connection);
const workers = startWorkers({ connection, pool, sources, queues, log });

if (config.DISCOVERY_EVERY_MINUTES > 0) {
  const every = config.DISCOVERY_EVERY_MINUTES * 60_000;
  await queues.discover.upsertJobScheduler('hn-yc-jobs', { every }, {
    name: 'discover',
    data: { source: 'hackernews', scope: 'jobstories' },
  });
  await queues.discover.upsertJobScheduler('hn-who-is-hiring', { every }, {
    name: 'discover',
    data: { source: 'hackernews', scope: 'whoishiring' },
  });
  log.info({ everyMinutes: config.DISCOVERY_EVERY_MINUTES }, 'scheduled discovery enabled');
}

const metricsServer = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
  } else {
    res.statusCode = 404;
    res.end();
  }
});
// Metrics are observability, not ingestion: a port clash must not take the worker down.
metricsServer.on('error', (err) => log.error({ err }, 'metrics server failed; continuing without /metrics'));
metricsServer.listen(config.WORKER_METRICS_PORT);

log.info({ sources: sources.names(), concurrency: config.INGEST_CONCURRENCY, metricsPort: config.WORKER_METRICS_PORT }, 'workers started');

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down: finishing in-flight jobs');
  metricsServer.close();
  await workers.close(); // waits for active jobs; unfinished ones are picked up again after restart
  await queues.close();
  await pool.end();
  connection.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
