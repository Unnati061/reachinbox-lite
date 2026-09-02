import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
}));

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({ eval: mocks.eval }),
}));

const { reserveSenderSendSlot } = await import('../src/services/sender-rate-limiter.js');

beforeEach(() => vi.clearAllMocks());

describe('reserveSenderSendSlot', () => {
  it('atomically reserves a rolling-window slot for an allowed send', async () => {
    mocks.eval.mockResolvedValue([1, 0]);
    const now = new Date('2026-09-02T10:00:00.000Z');

    await expect(
      reserveSenderSendSlot({
        senderId: 'sender-1',
        reservationId: 'job-1:0',
        hourlyLimit: 200,
        now,
      }),
    ).resolves.toEqual({ allowed: true, retryAt: null });

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining('ZREMRANGEBYSCORE'),
      1,
      'reachinbox:sender-send-attempts:sender-1',
      String(now.getTime()),
      '3600000',
      '200',
      'job-1:0',
    );
  });

  it('returns the oldest reservation expiry when the cap is full', async () => {
    const retryAt = new Date('2026-09-02T11:00:00.000Z');
    mocks.eval.mockResolvedValue([0, retryAt.getTime()]);

    await expect(
      reserveSenderSendSlot({ senderId: 'sender-1', reservationId: 'job-2:0', hourlyLimit: 1 }),
    ).resolves.toEqual({ allowed: false, retryAt });
  });

  it('fails closed when Redis returns a malformed script result', async () => {
    mocks.eval.mockResolvedValue('not-a-script-result');

    await expect(
      reserveSenderSendSlot({ senderId: 'sender-1', reservationId: 'job-3:0', hourlyLimit: 1 }),
    ).rejects.toThrow('Unexpected Redis sender rate-limit response');
  });
});
