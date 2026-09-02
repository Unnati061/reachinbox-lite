/**
 * Endpoint tests for /api/emails/*.
 *
 * Prisma and BullMQ are mocked. That is a deliberate limit, not an oversight:
 * the suite has to pass with Postgres and Redis down (a property Phase 1
 * committed to), so these tests prove routing, validation, status codes, the
 * error envelope, and the *shape and arguments* of every write — not that the
 * SQL executes. Executing it is verified separately against a live database.
 */

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../src/middleware/error-handler.js';
import type {
  PaginatedResponse,
  ScheduleBatchResource,
  ScheduledEmailListItem,
} from '../src/routes/email.serializers.js';
// Imported for its type only, to spread the real module in the mock factory
// below; an inline `typeof import(...)` would trip consistent-type-imports.
import type * as QueueService from '../src/services/queue.service.js';

const mocks = vi.hoisted(() => {
  type Args = Record<string, unknown>;
  return {
    prisma: {
      sender: {
        findUnique: vi.fn<(args: { where: Args }) => Promise<unknown>>(),
      },
      scheduleBatch: {
        create: vi.fn<(args: { data: Args }) => Promise<unknown>>(),
      },
      scheduledEmail: {
        createManyAndReturn: vi.fn<(args: { data: Args[] }) => Promise<unknown>>(),
        count: vi.fn<(args: Args) => Promise<number>>(),
        findMany: vi.fn<(args: Args) => Promise<unknown[]>>(),
      },
      $transaction: vi.fn<(ops: Promise<unknown>[]) => Promise<unknown[]>>(),
      $executeRaw: vi.fn<(...args: unknown[]) => Promise<number>>(),
    },
    addBulk: vi.fn<(jobs: unknown[]) => Promise<unknown[]>>(),
  };
});

vi.mock('../src/db/client.js', () => ({
  prisma: mocks.prisma,
  disconnectDatabase: vi.fn(),
}));

vi.mock('../src/services/queue.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, getEmailDispatchQueue: () => ({ addBulk: mocks.addBulk }) };
});

const { createApp } = await import('../src/app.js');

/** Narrow the `any` supertest hands back, matching the style in app.test.ts. */
function batchOf(response: { body: unknown }): ScheduleBatchResource {
  return response.body as ScheduleBatchResource;
}

function errorOf(response: { body: unknown }): ApiErrorBody['error'] {
  return (response.body as ApiErrorBody).error;
}

const NOW = new Date('2026-09-02T10:00:00.000Z');

const SENDER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  smtpCredentialRef: 'default',
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

/** Stands in for what `createManyAndReturn` gives back: the row plus defaults. */
function asStoredRow(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    status: 'pending',
    bullmqJobId: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    sentAt: null,
  };
}

const app = createApp();

beforeEach(() => {
  // Only Date is faked, so supertest's sockets and timers still work. Every
  // BullMQ delay in these tests is therefore exactly predictable.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  // `restoreMocks: true` in vitest.config.ts restores spies created with
  // vi.spyOn; these are standalone vi.fn()s, so their call history survives
  // into the next test unless it is cleared here. Without this, assertions
  // like `not.toHaveBeenCalled()` read a previous test's writes.
  vi.clearAllMocks();

  mocks.prisma.sender.findUnique.mockResolvedValue(SENDER);
  mocks.prisma.scheduleBatch.create.mockImplementation((args) => Promise.resolve(args.data));
  mocks.prisma.scheduledEmail.createManyAndReturn.mockImplementation((args) =>
    Promise.resolve(args.data.map(asStoredRow)),
  );
  mocks.prisma.$transaction.mockImplementation((ops) => Promise.all(ops));
  mocks.prisma.$executeRaw.mockResolvedValue(1);
  mocks.addBulk.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The rows handed to createManyAndReturn on the most recent call. */
function writtenRows(): Record<string, unknown>[] {
  const call = mocks.prisma.scheduledEmail.createManyAndReturn.mock.calls.at(-1);
  return call?.[0].data ?? [];
}

/** The jobs handed to addBulk on the most recent call. */
function enqueuedJobs(): {
  name: string;
  data: { scheduledEmailId: string };
  opts: { jobId: string; delay: number };
}[] {
  const call = mocks.addBulk.mock.calls.at(-1);
  return (call?.[0] ?? []) as ReturnType<typeof enqueuedJobs>;
}

describe('POST /api/emails/schedule', () => {
  it('writes a row per recipient and enqueues a job per row', async () => {
    const startAt = new Date(NOW.getTime() + 60 * 60_000);

    const response = await request(app)
      .post('/api/emails/schedule')
      .send({
        sender: SENDER.email,
        subject: 'Warm-up',
        body: 'Hello there',
        recipients: ['One@example.com', 'two@example.com', 'three@example.com'],
        start_time: startAt.toISOString(),
        delay_between_emails_ms: 60_000,
      });

    expect(response.status).toBe(201);
    expect(batchOf(response)).toMatchObject({
      scheduled_count: 3,
      duplicates_removed: 0,
      effective_step_ms: 60_000,
      requested_delay_between_emails_ms: 60_000,
      hourly_limit: null,
      widened_by_hourly_limit: false,
      start_at: startAt.toISOString(),
      last_scheduled_at: new Date(startAt.getTime() + 120_000).toISOString(),
      sender: { id: SENDER.id, email: SENDER.email, display_name: SENDER.displayName },
    });

    const rows = writtenRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.recipientEmail)).toEqual([
      // Normalised on the way in.
      'one@example.com',
      'two@example.com',
      'three@example.com',
    ]);
    // Subject and body are copied onto every row: this table is the delivery
    // record, so it must not depend on the batch staying unedited.
    expect(rows.every((row) => row.subject === 'Warm-up' && row.body === 'Hello there')).toBe(true);
    expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
    expect(rows.every((row) => row.senderId === SENDER.id)).toBe(true);

    const jobs = enqueuedJobs();
    expect(jobs).toHaveLength(3);
    // The job id IS the row id — that is what makes re-enqueueing idempotent.
    expect(jobs.map((job) => job.opts.jobId)).toEqual(rows.map((row) => row.id));
    expect(jobs.map((job) => job.data.scheduledEmailId)).toEqual(rows.map((row) => row.id));
    // One hour until start, then one minute per step.
    expect(jobs.map((job) => job.opts.delay)).toEqual([3_600_000, 3_660_000, 3_720_000]);

    // The batch row records what the planner used, not just what was asked.
    expect(mocks.prisma.scheduleBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        senderId: SENDER.id,
        delayBetweenEmailsMs: 60_000,
        hourlyLimit: null,
        effectiveStepMs: 60_000,
      }) as unknown,
    });

    // bullmq_job_id is stamped only after the enqueue succeeds.
    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('commits before it enqueues', async () => {
    const order: string[] = [];
    mocks.prisma.scheduledEmail.createManyAndReturn.mockImplementation((args) => {
      order.push('insert');
      return Promise.resolve(args.data.map(asStoredRow));
    });
    mocks.addBulk.mockImplementation(() => {
      order.push('enqueue');
      return Promise.resolve([]);
    });

    await request(app)
      .post('/api/emails/schedule')
      .send({ sender: SENDER.email, subject: 'S', body: 'B', recipients: 'a@example.com' })
      .expect(201);

    // A job that fires against a rolled-back row retries five times against
    // something that will never exist; a row with no job is repairable.
    expect(order).toEqual(['insert', 'enqueue']);
  });

  it('drops duplicate recipients and says how many', async () => {
    const response = await request(app)
      .post('/api/emails/schedule')
      .send({
        sender: SENDER.email,
        subject: 'S',
        body: 'B',
        recipients: ['dup@example.com', 'DUP@Example.com', 'other@example.com'],
        delay_between_emails_ms: 1_000,
      })
      .expect(201);

    expect(batchOf(response)).toMatchObject({ scheduled_count: 2, duplicates_removed: 1 });
    expect(writtenRows().map((row) => row.recipientEmail)).toEqual([
      'dup@example.com',
      'other@example.com',
    ]);
  });

  it('lets hourly_limit widen the step, and reports that it did', async () => {
    const response = await request(app)
      .post('/api/emails/schedule')
      .send({
        sender: SENDER.email,
        subject: 'S',
        body: 'B',
        recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
        delay_between_emails_ms: 1_000,
        hourly_limit: 7,
      })
      .expect(201);

    // ceil(3_600_000 / 7) = 514_286, well above the 1_000 ms requested.
    expect(batchOf(response)).toMatchObject({
      effective_step_ms: 514_286,
      requested_delay_between_emails_ms: 1_000,
      hourly_limit: 7,
      widened_by_hourly_limit: true,
    });
    expect(enqueuedJobs().map((job) => job.opts.delay)).toEqual([0, 514_286, 1_028_572]);
  });

  it('accepts a single recipient as a bare string with no delay', async () => {
    const response = await request(app)
      .post('/api/emails/schedule')
      .send({ sender: SENDER.email, subject: 'S', body: 'B', recipients: 'solo@example.com' })
      .expect(201);

    expect(batchOf(response)).toMatchObject({ scheduled_count: 1, effective_step_ms: 0 });
    expect(enqueuedJobs().map((job) => job.opts.delay)).toEqual([0]);
  });

  it('resolves a sender given as a UUID', async () => {
    await request(app)
      .post('/api/emails/schedule')
      .send({ sender: SENDER.id, subject: 'S', body: 'B', recipients: 'a@example.com' })
      .expect(201);

    expect(mocks.prisma.sender.findUnique).toHaveBeenCalledWith({ where: { id: SENDER.id } });
  });

  it('404s on an unknown sender and writes nothing', async () => {
    mocks.prisma.sender.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/emails/schedule')
      .send({ sender: 'ghost@example.com', subject: 'S', body: 'B', recipients: 'a@example.com' })
      .expect(404);

    expect(errorOf(response)).toMatchObject({ code: 'NOT_FOUND' });
    expect(errorOf(response).message).toContain('not created implicitly');
    expect(mocks.prisma.scheduledEmail.createManyAndReturn).not.toHaveBeenCalled();
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });

  it('422s on a disabled sender', async () => {
    mocks.prisma.sender.findUnique.mockResolvedValue({ ...SENDER, isActive: false });

    const response = await request(app)
      .post('/api/emails/schedule')
      .send({ sender: SENDER.email, subject: 'S', body: 'B', recipients: 'a@example.com' })
      .expect(422);

    expect(errorOf(response)).toMatchObject({ code: 'UNPROCESSABLE_ENTITY' });
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });

  it('400s on a validation failure, naming the field, without touching the database', async () => {
    const response = await request(app)
      .post('/api/emails/schedule')
      .send({
        sender: SENDER.email,
        subject: 'S',
        body: 'B',
        recipients: ['a@example.com', 'nope'],
        delay_between_emails_ms: 1_000,
      })
      .expect(400);

    expect(errorOf(response)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(errorOf(response).details).toEqual([
      { path: 'recipients.1', message: expect.stringContaining('email') as unknown },
    ]);
    expect(errorOf(response).requestId).toEqual(expect.any(String));
    expect(mocks.prisma.sender.findUnique).not.toHaveBeenCalled();
  });

  it('422s on a start time well in the past', async () => {
    const response = await request(app)
      .post('/api/emails/schedule')
      .send({
        sender: SENDER.email,
        subject: 'S',
        body: 'B',
        recipients: 'a@example.com',
        start_time: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      })
      .expect(422);

    expect(errorOf(response)).toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      details: { reason: 'start_too_far_past' },
    });
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });

  it('503s when the rows commit but the queue refuses them', async () => {
    mocks.addBulk.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await request(app)
      .post('/api/emails/schedule')
      .send({ sender: SENDER.email, subject: 'S', body: 'B', recipients: 'a@example.com' })
      .expect(503);

    // 201 here would tell the caller mail is going out when nothing is armed.
    expect(errorOf(response)).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { enqueued: false, scheduledCount: 1 },
    });
    expect(mocks.prisma.scheduledEmail.createManyAndReturn).toHaveBeenCalled();
    // Left NULL on purpose: that is the marker a reconciliation sweep looks for.
    expect(mocks.prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

/** A stored row, shaped as Prisma would hand it back. */
function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    batchId: '33333333-3333-4333-8333-333333333333',
    senderId: SENDER.id,
    recipientEmail: 'a@example.com',
    subject: 'Subject line',
    body: 'A very long body that list responses have no business carrying',
    scheduledAt: NOW,
    status: 'pending',
    bullmqJobId: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    sentAt: null,
    ...overrides,
  };
}

/** The findMany arguments from the most recent call. */
function queryArgs(): Record<string, unknown> {
  return mocks.prisma.scheduledEmail.findMany.mock.calls.at(-1)?.[0] ?? {};
}

describe('GET /api/emails/scheduled', () => {
  beforeEach(() => {
    mocks.prisma.scheduledEmail.count.mockResolvedValue(42);
    mocks.prisma.scheduledEmail.findMany.mockResolvedValue([storedRow()]);
  });

  it('returns pending and processing rows, soonest first', async () => {
    const response = await request(app).get('/api/emails/scheduled').expect(200);
    const body = response.body as PaginatedResponse<ScheduledEmailListItem>;

    expect(queryArgs()).toMatchObject({
      where: { status: { in: ['pending', 'processing'] } },
      // The id tie-break matters: a batch sent with delay 0 shares one
      // scheduled_at, and offset paging over a non-unique key repeats rows.
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      skip: 0,
      take: 25,
    });

    expect(body.meta).toEqual({
      page: 1,
      per_page: 25,
      total: 42,
      total_pages: 2,
      has_more: true,
    });
    expect(body.data.at(0)).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      recipient_email: 'a@example.com',
      subject: 'Subject line',
      status: 'pending',
      scheduled_at: NOW.toISOString(),
      sent_at: null,
    });
  });

  it('omits the message body from list rows', async () => {
    const response = await request(app).get('/api/emails/scheduled').expect(200);
    const body = response.body as PaginatedResponse<ScheduledEmailListItem>;

    // 100 rows x 100k characters is a 10 MB response for a table view.
    expect(body.data.at(0)).not.toHaveProperty('body');
  });

  it('translates page and per_page into skip and take', async () => {
    const response = await request(app).get('/api/emails/scheduled?page=3&per_page=10').expect(200);
    const body = response.body as PaginatedResponse<ScheduledEmailListItem>;

    expect(queryArgs()).toMatchObject({ skip: 20, take: 10 });
    expect(body.meta).toEqual({
      page: 3,
      per_page: 10,
      total: 42,
      total_pages: 5,
      has_more: true,
    });
  });

  it('reports the last page as having no more', async () => {
    mocks.prisma.scheduledEmail.count.mockResolvedValue(20);

    const response = await request(app).get('/api/emails/scheduled?per_page=10&page=2');
    const body = response.body as PaginatedResponse<ScheduledEmailListItem>;

    expect(body.meta).toMatchObject({ total_pages: 2, has_more: false });
  });

  it('400s on a page size above the cap', async () => {
    const response = await request(app).get('/api/emails/scheduled?per_page=1000').expect(400);
    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.scheduledEmail.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/emails/sent', () => {
  it('returns sent and failed rows, most recent first, with the failure reason', async () => {
    mocks.prisma.scheduledEmail.count.mockResolvedValue(2);
    mocks.prisma.scheduledEmail.findMany.mockResolvedValue([
      storedRow({ status: 'sent', sentAt: NOW, bullmqJobId: 'job-1' }),
      storedRow({
        id: '44444444-4444-4444-8444-444444444444',
        status: 'failed',
        error: 'SMTP 550 mailbox unavailable',
      }),
    ]);

    const response = await request(app).get('/api/emails/sent').expect(200);
    const body = response.body as PaginatedResponse<ScheduledEmailListItem>;

    expect(queryArgs()).toMatchObject({
      where: { status: { in: ['sent', 'failed'] } },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
    });

    expect(body.data.map((row) => row.status)).toEqual(['sent', 'failed']);
    expect(body.data.at(0)).toMatchObject({ sent_at: NOW.toISOString(), bullmq_job_id: 'job-1' });
    // A failure keeps its reason and never gets a sent_at.
    expect(body.data.at(1)).toMatchObject({
      error: 'SMTP 550 mailbox unavailable',
      sent_at: null,
    });
  });
});
