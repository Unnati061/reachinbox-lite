/**
 * Worker entry point — a separate process from the API.
 *
 * Run it with `npm run dev:worker` (or `npm run start:worker`). Kept separate so
 * a slow or crashing send loop cannot take HTTP traffic down with it, and so the
 * two can be scaled independently.
 */
import { config } from '../config/config.js';
import { disconnectDatabase } from '../db/client.js';
import { disconnectRedis } from '../db/redis.js';
import { logger } from '../logger.js';
import { closeMailer, verifyMailer } from '../services/mailer.js';
import { QUEUE_NAMES } from '../services/queue.service.js';
import { createEmailWorker, EMAIL_WORKER_CONCURRENCY } from './email.worker.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

const worker = createEmailWorker();

logger.info(
  {
    queue: QUEUE_NAMES.emailDispatch,
    concurrency: EMAIL_WORKER_CONCURRENCY,
    env: config.nodeEnv,
    mailConfigured: config.mail.isConfigured,
  },
  'Worker started',
);

if (config.mail.isConfigured) {
  // Fire-and-forget: a bad SMTP config should surface loudly at startup, but it
  // must not stop the worker booting — jobs will fail and retry, which is the
  // same signal with a paper trail.
  void verifyMailer()
    .then(() => {
      logger.info('SMTP transport verified');
    })
    .catch((error: unknown) => {
      logger.error(
        { err: error },
        'SMTP verification failed — sends will fail until SMTP settings are corrected',
      );
    });
} else {
  logger.warn('SMTP is not configured — dispatch jobs will fail until SMTP_HOST and MAIL_FROM are set');
}

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Shutting down worker');

  // Longer than the API's window: an in-flight send should be allowed to finish
  // rather than be retried and risk a duplicate email.
  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Worker shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let code = exitCode;
  try {
    // Stop accepting jobs and let in-flight sends finish before tearing down the
    // connections they depend on.
    await worker.close();
    closeMailer();
    await disconnectDatabase();
    await disconnectRedis();
    logger.info('Worker shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'Error during worker shutdown');
    code = 1;
  } finally {
    clearTimeout(forceExit);
    process.exit(code);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception in worker');
  void shutdown('uncaughtException', 1);
});
