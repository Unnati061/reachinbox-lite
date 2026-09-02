import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { config } from '../config/config.js';
import { prisma } from '../db/client.js';
import { EmailStatus } from '../db/generated/enums.js';
import { createRedisConnection } from '../db/redis.js';
import { logger } from '../logger.js';
import { sendEmail } from '../services/mailer.js';
import { QUEUE_NAMES } from '../services/queue.service.js';
import type { EmailDispatchJob } from '../services/queue.service.js';
import { reserveSenderSendSlot } from '../services/sender-rate-limiter.js';
import { notifySlackRateLimit } from '../services/slack.service.js';
import { indexEmail } from '../services/email-search.service.js';

/** Exported for startup logging and tests; configured through `backend/.env`. */
export const EMAIL_WORKER_CONCURRENCY = config.delivery.workerConcurrency;

/** The error column is unbounded, but a multi-kilobyte SMTP transcript in a list view helps no one. */
const MAX_ERROR_LENGTH = 1000;

/** SMTP replies carry a numeric response code; 5xx is a permanent refusal, 4xx transient. */
function smtpResponseCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'responseCode' in error) {
    const code = error.responseCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH - 3)}...` : raw;
}

async function markFailed(id: string, message: string): Promise<void> {
  const updated = await prisma.scheduledEmail.update({
    where: { id },
    data: { status: EmailStatus.failed, error: message },
    include: { sender: true },
  });
  await indexEmail(updated, updated.sender);
}

/**
 * Send one scheduled email.
 *
 * Exported so the unit suite can drive it with a mocked Prisma and mailer
 * (Postgres and Redis down), the same contract as the route tests.
 *
 * The row — not the job payload — is the source of truth: the job carries only
 * an id, so a send cancelled or edited after enqueue is honoured here. Delivery
 * is at-least-once, so this must be safe to run twice: an already-`sent` row is
 * skipped rather than re-mailed.
 */
export async function processEmailDispatch(job: Job<EmailDispatchJob>): Promise<void> {
  const { scheduledEmailId } = job.data;
  const maxAttempts = job.opts.attempts ?? 1;
  const log = logger.child({
    jobId: job.id,
    scheduledEmailId,
    attempt: job.attemptsMade + 1,
    maxAttempts,
  });

  const email = await prisma.scheduledEmail.findUnique({
    where: { id: scheduledEmailId },
    include: { sender: true },
  });

  // Cancelled or deleted between enqueue and now: nothing to send, nothing to
  // retry. Let the job complete quietly rather than failing on a phantom.
  if (email === null) {
    log.warn('Scheduled email not found; nothing to send (cancelled or deleted)');
    return;
  }

  // The stop sign for at-least-once redelivery — re-sending would double-mail.
  if (email.status === EmailStatus.sent) {
    log.info('Already marked sent; skipping');
    return;
  }

  const reservation = await reserveSenderSendSlot({
    senderId: email.senderId,
    // A retry is a new provider attempt, while duplicate evaluation of the
    // same active attempt is harmlessly idempotent in the sorted set.
    reservationId: `${scheduledEmailId}:${String(job.attemptsMade)}`,
    hourlyLimit: config.delivery.maxEmailsPerHourPerSender,
  });

  if (!reservation.allowed) {
    const retryAt = reservation.retryAt;
    if (retryAt === null) throw new Error('Rate limiter denied a send without a retry time');

    // Do not occupy a worker slot for up to an hour. BullMQ moves this *same*
    // job back to delayed state (preserving its identity and attempt count),
    // then DelayedError tells the worker not to mark it as failed/completed.
    await job.moveToDelayed(retryAt.getTime(), job.token);
    void notifySlackRateLimit(email.senderId, retryAt).catch((error: unknown) => {
      // Notification delivery is deliberately non-blocking, but its promise
      // still must be observed so a broken integration cannot become an
      // unhandled rejection in the worker process.
      log.error({ err: error }, 'Unexpected Slack notification failure');
    });
    log.info({ retryAt }, 'Sender hourly limit reached; job returned to delayed queue');
    throw new DelayedError();
  }

  // Claim the row so a concurrent worker (or the dashboard) sees it in flight.
  await prisma.scheduledEmail.update({
    where: { id: email.id },
    data: { status: EmailStatus.processing },
  });

  let outcome;
  try {
    outcome = await sendEmail({
      // From is the registered sender's identity — the whole point of a sender
      // is to send as them. MAIL_FROM is the envelope (bounce) address, shared
      // across senders. See DECISIONS.md.
      from: { name: email.sender.displayName, address: email.sender.email },
      to: email.recipientEmail,
      subject: email.subject,
      text: email.body,
      ...(config.mail.from === undefined
        ? {}
        : { envelope: { from: config.mail.from, to: email.recipientEmail } }),
    });
  } catch (error) {
    const responseCode = smtpResponseCode(error);
    const message = errorMessage(error);
    const permanent = responseCode !== undefined && responseCode >= 500 && responseCode < 600;

    if (permanent) {
      // A 5xx is the server saying "never"; retrying five times only annoys it.
      await markFailed(email.id, message);
      log.warn({ responseCode }, 'Permanent SMTP rejection; marked failed, not retrying');
      throw new UnrecoverableError(message);
    }

    // Transient (network, 4xx, or unconfigured SMTP): keep the row in-flight,
    // record the latest reason, and let BullMQ retry under its backoff. The row
    // is marked failed only once retries are exhausted — see the worker's
    // `failed` handler / markScheduledEmailFailedIfExhausted.
    await prisma.scheduledEmail.update({ where: { id: email.id }, data: { error: message } });
    log.warn({ responseCode, err: error }, 'SMTP send failed; will retry if attempts remain');
    throw error instanceof Error ? error : new Error(message);
  }

  if (outcome.acceptedCount === 0) {
    // The server answered but took no recipient — the same address will be
    // refused again, so treat it as permanent rather than burning retries.
    const message = `No recipient accepted by SMTP server (rejected: ${outcome.rejected.join(', ')})`;
    await markFailed(email.id, message);
    log.warn({ rejected: outcome.rejected }, 'Send accepted no recipients; marked failed');
    throw new UnrecoverableError(message);
  }

  const sent = await prisma.scheduledEmail.update({
    where: { id: email.id },
    data: { status: EmailStatus.sent, sentAt: new Date(), error: null },
    include: { sender: true },
  });
  await indexEmail(sent, sent.sender);
  log.info(
    {
      messageId: outcome.messageId,
      preview: outcome.previewUrl === false ? undefined : outcome.previewUrl,
    },
    'Email sent',
  );
}

/**
 * Mark a row failed once its job has run out of retries.
 *
 * Transient failures leave the row `processing` and re-throw so BullMQ retries;
 * on the final attempt there is no further run to record the outcome, so the
 * worker's `failed` event calls this. Permanent failures are already marked in
 * the processor, so a re-mark here (if the counts line up) is idempotent.
 */
export async function markScheduledEmailFailedIfExhausted(
  job: Job<EmailDispatchJob>,
  error: Error,
): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // a retry is still coming
  await markFailed(job.data.scheduledEmailId, errorMessage(error));
}

export function createEmailWorker(): Worker<EmailDispatchJob> {
  const worker = new Worker<EmailDispatchJob>(QUEUE_NAMES.emailDispatch, processEmailDispatch, {
    connection: createRedisConnection('queue'),
    concurrency: EMAIL_WORKER_CONCURRENCY,
    // BullMQ's limiter is Redis-backed and therefore applies across every
    // worker process on this queue. It is the minimum gap between *all*
    // provider attempts; the sender limiter above independently enforces the
    // per-sender rolling hourly cap.
    ...(config.delivery.minSendIntervalMs === 0
      ? {}
      : { limiter: { max: 1, duration: config.delivery.minSendIntervalMs } }),
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Email dispatch job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, attempt: job?.attemptsMade, err: error },
      'Email dispatch job failed',
    );
    if (job !== undefined) {
      void markScheduledEmailFailedIfExhausted(job, error).catch((dbError: unknown) => {
        logger.error(
          { jobId: job.id, err: dbError },
          'Could not mark scheduled email failed after exhausting retries',
        );
      });
    }
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'Email worker error');
  });

  return worker;
}
