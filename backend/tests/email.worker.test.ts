/**
 * Unit tests for the email dispatch worker's processor.
 *
 * Prisma and the mailer are mocked — same deliberate limit as the route tests:
 * the suite must pass with Postgres and Redis down, so these prove the
 * processor's decisions (claim, skip, send, classify failures) and the exact
 * writes it makes, not that SQL or SMTP runs. A real send is verified
 * separately, end to end, against Neon → Upstash → Ethereal.
 */

import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendOutcome } from '../src/services/mailer.js';
import type { EmailDispatchJob } from '../src/services/queue.service.js';

const mocks = vi.hoisted(() => {
  type Args = Record<string, unknown>;
  return {
    prisma: {
      scheduledEmail: {
        findUnique: vi.fn<(args: Args) => Promise<unknown>>(),
        update: vi.fn<(args: { where: Args; data: Args }) => Promise<unknown>>(),
      },
    },
    sendEmail: vi.fn<(message: Record<string, unknown>) => Promise<SendOutcome>>(),
    reserveSenderSendSlot: vi.fn<() => Promise<{ allowed: boolean; retryAt: Date | null }>>(),
  };
});

vi.mock('../src/db/client.js', () => ({
  prisma: mocks.prisma,
  disconnectDatabase: vi.fn(),
}));

vi.mock('../src/services/mailer.js', () => ({
  sendEmail: mocks.sendEmail,
  verifyMailer: vi.fn(),
  closeMailer: vi.fn(),
}));

vi.mock('../src/services/sender-rate-limiter.js', () => ({
  reserveSenderSendSlot: mocks.reserveSenderSendSlot,
}));

const { processEmailDispatch, markScheduledEmailFailedIfExhausted } =
  await import('../src/workers/email.worker.js');

const EMAIL_ID = '22222222-2222-4222-8222-222222222222';

const SENDER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
};

/** A stored row joined with its sender, as `findUnique({ include: { sender } })` returns it. */
function emailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EMAIL_ID,
    senderId: SENDER.id,
    recipientEmail: 'recipient@example.com',
    subject: 'Warm-up',
    body: 'Hello there',
    status: 'pending',
    error: null,
    sentAt: null,
    sender: SENDER,
    ...overrides,
  };
}

/** A minimal Job carrying only the fields the processor reads. */
function makeJob(
  overrides: {
    scheduledEmailId?: string;
    attemptsMade?: number;
    attempts?: number;
    id?: string;
  } = {},
): Job<EmailDispatchJob> {
  return {
    id: overrides.id ?? 'job-1',
    data: { scheduledEmailId: overrides.scheduledEmailId ?? EMAIL_ID },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 5 },
  } as unknown as Job<EmailDispatchJob>;
}

/** The `data` payload of every scheduledEmail.update call, in order. */
function updateData(): Record<string, unknown>[] {
  return mocks.prisma.scheduledEmail.update.mock.calls.map((call) => call[0].data);
}

/** An SMTP-style error: nodemailer hangs a numeric responseCode off the Error. */
function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

beforeEach(() => {
  // restoreMocks only resets spies; these standalone vi.fn()s keep their call
  // history between tests unless cleared here (see email.routes.test.ts).
  vi.clearAllMocks();

  mocks.prisma.scheduledEmail.findUnique.mockResolvedValue(emailRow());
  mocks.prisma.scheduledEmail.update.mockImplementation((args) => Promise.resolve(args.data));
  mocks.sendEmail.mockResolvedValue({
    acceptedCount: 1,
    rejected: [],
    messageId: '<abc@ethereal>',
    previewUrl: 'https://ethereal.email/message/abc',
  });
  mocks.reserveSenderSendSlot.mockResolvedValue({ allowed: true, retryAt: null });
});

describe('processEmailDispatch', () => {
  it('claims the row, sends as the sender, and marks it sent', async () => {
    await processEmailDispatch(makeJob());

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls.at(0)?.[0]).toMatchObject({
      // From is the sender's identity, not the SMTP account.
      from: { name: 'Ada Lovelace', address: 'ada@example.com' },
      to: 'recipient@example.com',
      subject: 'Warm-up',
      text: 'Hello there',
    });

    const updates = updateData();
    expect(updates.at(0)).toMatchObject({ status: 'processing' });
    expect(updates.at(-1)).toMatchObject({ status: 'sent', error: null });
    expect(updates.at(-1)?.sentAt).toBeInstanceOf(Date);
  });

  it('skips a row already marked sent without re-sending', async () => {
    mocks.prisma.scheduledEmail.findUnique.mockResolvedValue(emailRow({ status: 'sent' }));

    await processEmailDispatch(makeJob());

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });

  it('completes quietly when the row is gone (cancelled or deleted)', async () => {
    mocks.prisma.scheduledEmail.findUnique.mockResolvedValue(null);

    await expect(processEmailDispatch(makeJob())).resolves.toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });

  it('returns the job to delayed state without sending when the sender is at its hourly cap', async () => {
    const retryAt = new Date('2026-09-02T12:00:00.000Z');
    mocks.reserveSenderSendSlot.mockResolvedValue({ allowed: false, retryAt });
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const job = Object.assign(makeJob(), {
      token: 'worker-lock-token',
      moveToDelayed,
    });

    await expect(processEmailDispatch(job)).rejects.toMatchObject({ name: 'DelayedError' });

    expect(moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), 'worker-lock-token');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });

  it('marks failed and refuses to retry on a 5xx rejection', async () => {
    mocks.sendEmail.mockRejectedValue(smtpError('550 mailbox unavailable', 550));

    await expect(processEmailDispatch(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);

    const updates = updateData();
    expect(updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(updates.at(-1)?.error).toContain('550');
  });

  it('records the reason and re-throws a retryable error on a transient failure', async () => {
    mocks.sendEmail.mockRejectedValue(smtpError('421 service unavailable, try later', 421));

    const thrown = await processEmailDispatch(makeJob()).catch((error: unknown) => error);

    // Retryable: a plain Error, never Unrecoverable.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);

    const updates = updateData();
    // Claimed, then recorded the reason — but not marked failed; that waits for
    // retries to run out.
    expect(updates.some((data) => data.status === 'failed')).toBe(false);
    expect(updates.at(-1)).toMatchObject({ error: expect.stringContaining('421') as unknown });
  });

  it('marks failed and refuses to retry when the server accepts no recipient', async () => {
    mocks.sendEmail.mockResolvedValue({
      acceptedCount: 0,
      rejected: ['recipient@example.com'],
      messageId: undefined,
      previewUrl: false,
    });

    await expect(processEmailDispatch(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);

    const updates = updateData();
    expect(updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(updates.at(-1)?.error).toContain('recipient@example.com');
  });
});

describe('markScheduledEmailFailedIfExhausted', () => {
  it('marks the row failed once no retries remain', async () => {
    await markScheduledEmailFailedIfExhausted(
      makeJob({ attemptsMade: 5, attempts: 5 }),
      new Error('SMTP connection refused'),
    );

    expect(updateData().at(-1)).toMatchObject({
      status: 'failed',
      error: 'SMTP connection refused',
    });
  });

  it('does nothing while a retry is still coming', async () => {
    await markScheduledEmailFailedIfExhausted(
      makeJob({ attemptsMade: 2, attempts: 5 }),
      new Error('SMTP connection refused'),
    );

    expect(mocks.prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });
});
