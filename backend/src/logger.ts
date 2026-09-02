import pino from 'pino';
import { config } from './config/config.js';

/**
 * Process-wide structured logger.
 *
 * JSON in production (parseable by whatever ships the logs), pretty-printed in
 * development. `redact` is belt-and-braces: an email scheduler handles
 * recipient data and SMTP credentials, and log lines outlive requests.
 */
export const logger = pino({
  level: config.log.level,
  base: { service: 'reachinbox-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'smtp.password',
      'DATABASE_URL',
      'REDIS_URL',
    ],
    censor: '[redacted]',
  },
  ...(config.isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
