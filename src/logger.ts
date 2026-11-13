import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? 'hn-ingestion' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
