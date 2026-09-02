/**
 * API entry point. Importing ./config/config.js first is deliberate: a bad
 * environment throws here, before a port is bound or a connection is opened.
 */
import { config } from './config/config.js';
import { createApp } from './app.js';
import { disconnectDatabase } from './db/client.js';
import { disconnectRedis } from './db/redis.js';
import { logger } from './logger.js';
import { closeQueues } from './services/queue.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = createApp().listen(config.http.port, () => {
  logger.info(
    {
      port: config.http.port,
      env: config.nodeEnv,
      corsOrigins: config.http.corsOrigins,
      mailConfigured: config.mail.isConfigured,
    },
    'API listening',
  );
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Shutting down');

  // A stuck socket or a half-open Redis connection must not hold the process
  // open forever — orchestrators SIGKILL, and in-flight work is lost either way.
  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let code = exitCode;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await closeQueues();
    await disconnectDatabase();
    await disconnectRedis();
    logger.info('Shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
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
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
