import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { createRedisConnection } from '../db/redis.js';
import { logger } from '../logger.js';

export const QUEUE_NAMES = {
  emailDispatch: 'email-dispatch',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Payload for a single scheduled send.
 *
 * Provisional: it carries an id rather than the message itself so the worker
 * reads current state at send time (a send cancelled after enqueue must not go
 * out). The field name settles with the data model.
 */
export interface EmailDispatchJob {
  readonly scheduledEmailId: string;
}

/**
 * Retry policy for delivery attempts. SMTP failures are usually transient
 * (greylisting, rate limits), so back off over hours rather than seconds.
 * Completed jobs are kept for a week for auditing; failures for a month.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

let emailDispatchQueue: Queue<EmailDispatchJob> | undefined;

/**
 * Created on first use, not at import time — the API imports this module, and
 * merely importing it should not open a Redis connection.
 */
export function getEmailDispatchQueue(): Queue<EmailDispatchJob> {
  emailDispatchQueue ??= new Queue<EmailDispatchJob>(QUEUE_NAMES.emailDispatch, {
    connection: createRedisConnection('queue'),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return emailDispatchQueue;
}

/** Release queue connections during shutdown. Safe to call when nothing was opened. */
export async function closeQueues(): Promise<void> {
  if (emailDispatchQueue === undefined) return;
  const queue = emailDispatchQueue;
  emailDispatchQueue = undefined;
  await queue.close();
  logger.debug('Queue connections closed');
}
