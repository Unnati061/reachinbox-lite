import { Redis } from 'ioredis';
import { config } from '../config/config.js';
import { logger } from '../logger.js';

/**
 * `app`   — request-path commands (health probes, one-off reads). Fails fast so
 *           a readiness check reports "down" instead of hanging.
 * `queue` — handed to BullMQ. BullMQ blocks on long polls, so the per-request
 *           retry cap must be disabled or those calls abort mid-wait.
 */
export type RedisRole = 'app' | 'queue';

export function createRedisConnection(role: RedisRole): Redis {
  const connection = new Redis(config.redis.url, {
    maxRetriesPerRequest: role === 'queue' ? null : 2,
    lazyConnect: role === 'app',
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  // Redis being down is one event, not one event per reconnect attempt: report
  // the first failure loudly and drop the rest to debug.
  let reported = false;
  connection.on('error', (error: Error) => {
    if (reported) {
      logger.debug({ err: error, role }, 'Redis still unreachable');
      return;
    }
    reported = true;
    logger.error({ err: error, role }, 'Redis connection error');
  });
  connection.on('ready', () => {
    reported = false;
    logger.info({ role }, 'Redis connected');
  });

  return connection;
}

let appConnection: Redis | undefined;

/** Shared connection for request-path commands. Created on first use. */
export function getRedis(): Redis {
  appConnection ??= createRedisConnection('app');
  return appConnection;
}

export async function disconnectRedis(): Promise<void> {
  if (appConnection === undefined) return;
  const connection = appConnection;
  appConnection = undefined;
  await connection.quit();
}
