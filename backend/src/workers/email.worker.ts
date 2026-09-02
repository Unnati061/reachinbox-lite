import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { config } from '../config/config.js';
import { createRedisConnection } from '../db/redis.js';
import { NotImplementedError } from '../errors.js';
import { logger } from '../logger.js';
import { QUEUE_NAMES } from '../services/queue.service.js';
import type { EmailDispatchJob } from '../services/queue.service.js';

/** SMTP providers rate-limit; a handful of parallel sends is plenty. */
export const EMAIL_WORKER_CONCURRENCY = 5;

/**
 * Delivery is not implemented yet, and this throws rather than returning.
 *
 * A no-op processor would mark every scheduled send as completed without an
 * email ever leaving — silent data loss that looks like success in the UI. A
 * thrown error keeps the job in the queue, retried under DEFAULT_JOB_OPTIONS,
 * and visible as failed.
 */
async function processEmailDispatch(job: Job<EmailDispatchJob>): Promise<void> {
  logger.info(
    { jobId: job.id, attempt: job.attemptsMade + 1, scheduledEmailId: job.data.scheduledEmailId },
    'Email dispatch job received',
  );

  if (!config.mail.isConfigured) {
    throw new NotImplementedError('SMTP is unset (SMTP_HOST / MAIL_FROM); email delivery');
  }

  return Promise.reject(new NotImplementedError('Email delivery'));
}

export function createEmailWorker(): Worker<EmailDispatchJob> {
  const worker = new Worker<EmailDispatchJob>(QUEUE_NAMES.emailDispatch, processEmailDispatch, {
    connection: createRedisConnection('queue'),
    concurrency: EMAIL_WORKER_CONCURRENCY,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Email dispatch job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, attempt: job?.attemptsMade, err: error },
      'Email dispatch job failed',
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'Email worker error');
  });

  return worker;
}
