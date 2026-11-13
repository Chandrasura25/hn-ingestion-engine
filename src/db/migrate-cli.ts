import { logger } from '../logger.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const pool = createPool();
try {
  const applied = await migrate(pool);
  logger.info({ applied }, applied.length ? 'migrations applied' : 'schema up to date');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
