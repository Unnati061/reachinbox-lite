/**
 * Scheduling and listing of emails: the only module that writes to
 * `scheduled_emails`.
 *
 * The order of operations here is the important part. Rows are committed
 * first, jobs are enqueued second. The reverse — enqueue then insert — lets a
 * job fire against a row that a rolled-back transaction never created, and the
 * worker then retries five times against something that will never exist. A
 * committed row with no job is the better failure: it is queryable
 * (`bullmq_job_id IS NULL`), so a reconciliation sweep can repair it, and
 * because the BullMQ job id *is* the row id, re-enqueueing is idempotent.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.js';
import { EmailStatus } from '../db/generated/client.js';
import type { Prisma, ScheduledEmail, Sender } from '../db/generated/client.js';
import { HttpError } from '../errors.js';
import { logger } from '../logger.js';
import type { ListQuery, ScheduleEmailsBody, SenderReference } from '../schemas/email.schemas.js';
import { EMAIL_DISPATCH_JOB_NAME, getEmailDispatchQueue } from './queue.service.js';
import { indexEmail } from './email-search.service.js';
import { SchedulePlanError, planSchedule } from './schedule-planner.js';

/** What GET /api/emails/scheduled means: not yet resolved, one way or the other. */
export const SCHEDULED_STATUSES = [EmailStatus.pending, EmailStatus.processing] as const;

/** What GET /api/emails/sent means: finished, successfully or not. */
export const SENT_STATUSES = [EmailStatus.sent, EmailStatus.failed] as const;

export interface ScheduleEmailsResult {
  readonly sender: Sender;
  readonly batchId: string;
  readonly duplicatesRemoved: number;
  readonly requestedDelayMs: number;
  readonly hourlyLimit: number | null;
  readonly effectiveStepMs: number;
  readonly widenedByHourlyLimit: boolean;
  readonly startAt: Date;
  readonly lastScheduledAt: Date;
  readonly emails: readonly ScheduledEmail[];
}

export interface PagedEmails {
  readonly rows: readonly ScheduledEmail[];
  readonly total: number;
}

/**
 * Drop repeat recipients, keeping first-seen order, and report how many went.
 *
 * Addresses arrive already lowercased from the zod schema, so a plain Set is
 * case-insensitive here by construction. Silently sending the same person two
 * copies is a deliverability problem, and silently *dropping* the extras
 * without saying so is a support ticket, hence the count.
 */
export function dedupeRecipients(recipients: readonly string[]): {
  unique: string[];
  duplicatesRemoved: number;
} {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const recipient of recipients) {
    if (!seen.has(recipient)) {
      seen.add(recipient);
      unique.push(recipient);
    }
  }
  return { unique, duplicatesRemoved: recipients.length - unique.length };
}

/**
 * Look up the From identity. Never creates one.
 *
 * Auto-creating on a name that does not resolve would turn a typo into a new
 * sender with no SMTP credential behind it, and the batch would then fail at
 * send time — hundreds of rows deep, long after the request returned 201.
 */
async function resolveSender(reference: SenderReference): Promise<Sender> {
  const sender =
    reference.kind === 'id'
      ? await prisma.sender.findUnique({ where: { id: reference.value } })
      : await prisma.sender.findUnique({ where: { email: reference.value } });

  if (sender === null) {
    const described = reference.kind === 'id' ? `id ${reference.value}` : reference.value;
    throw HttpError.notFound(
      `No sender matches ${described}. Senders are not created implicitly — register one first.`,
    );
  }

  if (!sender.isActive) {
    throw HttpError.unprocessable(`Sender ${sender.email} is disabled and cannot send`, {
      senderId: sender.id,
    });
  }

  return sender;
}

/**
 * `planSchedule` with its domain errors mapped to HTTP.
 *
 * 422 rather than 400: the request parsed and every field was individually
 * valid. "Nine hundred recipients four hours apart" is a coherent sentence that
 * happens to describe five months of sending.
 */
function planOrReject(input: Parameters<typeof planSchedule>[0]): ReturnType<typeof planSchedule> {
  try {
    return planSchedule(input);
  } catch (error) {
    if (error instanceof SchedulePlanError) {
      throw HttpError.unprocessable(error.message, { reason: error.reason });
    }
    throw error;
  }
}

/**
 * Plan a batch, write it, and arm it.
 *
 * Returns the committed rows — `createManyAndReturn` gives back what Postgres
 * actually stored, so the response describes the database rather than the
 * request that was hoped to produce it.
 */
export async function scheduleEmails(body: ScheduleEmailsBody): Promise<ScheduleEmailsResult> {
  const sender = await resolveSender(body.sender);
  const { unique, duplicatesRemoved } = dedupeRecipients(body.recipients);

  // One clock reading for the whole request. It anchors the default start time
  // and every BullMQ delay, so the two cannot disagree by the duration of this
  // function.
  const now = new Date();
  const requestedDelayMs = body.delay_between_emails_ms ?? 0;
  const hourlyLimit = body.hourly_limit ?? null;

  const plan = planOrReject({
    startAt: body.start_time ?? now,
    recipientCount: unique.length,
    delayBetweenEmailsMs: requestedDelayMs,
    hourlyLimit: body.hourly_limit,
    now,
  });

  const batchId = randomUUID();
  const rows: Prisma.ScheduledEmailCreateManyInput[] = [];
  const jobs = [];

  // Ids are generated here, not by Postgres, because the BullMQ job id has to
  // equal the row id and the jobs are built in this same pass.
  for (const send of plan.sends) {
    const recipientEmail = unique[send.index];
    if (recipientEmail === undefined) {
      // Unreachable: planSchedule emits exactly recipientCount sends, 0..n-1.
      throw new Error(`Plan and recipient list disagree at index ${String(send.index)}`);
    }
    const id = randomUUID();
    rows.push({
      id,
      batchId,
      senderId: sender.id,
      recipientEmail,
      subject: body.subject,
      body: body.body,
      scheduledAt: send.scheduledAt,
    });
    jobs.push({
      name: EMAIL_DISPATCH_JOB_NAME,
      data: { scheduledEmailId: id },
      opts: { jobId: id, delay: send.delayMs },
    });
  }

  const [, created] = await prisma.$transaction([
    prisma.scheduleBatch.create({
      data: {
        id: batchId,
        senderId: sender.id,
        startAt: plan.startAt,
        delayBetweenEmailsMs: requestedDelayMs,
        hourlyLimit,
        effectiveStepMs: plan.effectiveStepMs,
      },
    }),
    prisma.scheduledEmail.createManyAndReturn({ data: rows }),
  ]);

  try {
    await getEmailDispatchQueue().addBulk(jobs);
  } catch (error) {
    // The rows are committed. Saying 503 rather than 201 is the honest answer:
    // "scheduled" is a promise this API cannot keep while the queue is down,
    // and a 201 would leave the caller believing mail is going out.
    logger.error(
      { err: error, batchId, count: rows.length },
      'Batch committed but not enqueued; rows left with bullmq_job_id NULL for reconciliation',
    );
    throw HttpError.serviceUnavailable(
      'The emails were saved but could not be queued for delivery, so nothing will send yet. ' +
        'Retry once the queue is reachable — re-arming this batch is safe, but re-posting it would duplicate the rows.',
      { batchId, scheduledCount: rows.length, enqueued: false },
    );
  }

  try {
    // One statement for the whole batch: the job id equals the row id by
    // construction, so this is a copy, not a per-row lookup. `IS NULL` keeps it
    // idempotent if a repair pass runs it again.
    await prisma.$executeRaw`
      UPDATE scheduled_emails
         SET bullmq_job_id = id::text,
             updated_at = now()
       WHERE batch_id = ${batchId}::uuid
         AND bullmq_job_id IS NULL
    `;
  } catch (error) {
    // The jobs exist and will fire. This column is a bookkeeping marker, so
    // failing to write it must not fail a request that actually succeeded.
    logger.warn({ err: error, batchId }, 'Jobs enqueued but bullmq_job_id was not recorded');
  }

  // Search is a rebuildable projection, not part of the scheduling transaction.
  // Index after the queue is armed; failure is observed/logged inside indexEmail
  // but cannot turn a durable schedule into an HTTP error.
  await Promise.all(created.map((row) => indexEmail(row, sender)));

  return {
    sender,
    batchId,
    duplicatesRemoved,
    requestedDelayMs,
    hourlyLimit,
    effectiveStepMs: plan.effectiveStepMs,
    widenedByHourlyLimit: plan.widenedByHourlyLimit,
    startAt: plan.startAt,
    lastScheduledAt: plan.lastScheduledAt,
    emails: created,
  };
}

export { searchEmails } from './email-search.service.js';

/**
 * One page of emails in the given states.
 *
 * `count` and `findMany` share a transaction, but Postgres READ COMMITTED takes
 * a fresh snapshot per statement, so `total` can still drift by a row or two
 * against a batch being written concurrently. For a list view that is a better
 * trade than the lock contention of a stricter isolation level.
 */
async function listByStatus(
  statuses: readonly EmailStatus[],
  query: ListQuery,
  direction: 'asc' | 'desc',
): Promise<PagedEmails> {
  const where: Prisma.ScheduledEmailWhereInput = { status: { in: [...statuses] } };

  // These are independent read-only queries. A Prisma array transaction can
  // fail to acquire a session through Neon/PgBouncer's transaction pool under
  // load (P2028), while it never supplied a shared snapshot at READ COMMITTED
  // anyway. Parallel queries retain the documented small count/list drift.
  const [total, rows] = await Promise.all([
    prisma.scheduledEmail.count({ where }),
    prisma.scheduledEmail.findMany({
      where,
      // The tie-break on id is not decoration. With delay_between_emails_ms of
      // 0 an entire batch shares one scheduled_at, and offset pagination over a
      // non-unique sort key silently repeats and skips rows across pages.
      orderBy: [{ scheduledAt: direction }, { id: direction }],
      skip: (query.page - 1) * query.per_page,
      take: query.per_page,
    }),
  ]);

  return { rows, total };
}

/** Ascending: what matters about a pending queue is what goes out next. */
export function listScheduledEmails(query: ListQuery): Promise<PagedEmails> {
  return listByStatus(SCHEDULED_STATUSES, query, 'asc');
}

/**
 * Descending: history reads newest-first.
 *
 * Ordered by `scheduled_at`, not `sent_at`: failed rows never get a `sent_at`,
 * and sorting by a nullable column would file every failure at one end of the
 * list instead of next to the sends it happened among.
 */
export function listSentEmails(query: ListQuery): Promise<PagedEmails> {
  return listByStatus(SENT_STATUSES, query, 'desc');
}
