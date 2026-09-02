import { describe, expect, it } from 'vitest';
import {
  HOUR_MS,
  MAX_HORIZON_MS,
  START_AT_GRACE_MS,
  SchedulePlanError,
  minStepForHourlyLimit,
  planSchedule,
} from '../src/services/schedule-planner.js';

/** Fixed reference instant, so nothing here depends on when it runs. */
const NOW = new Date('2026-09-02T10:00:00.000Z');

/** Offsets from `startAt`, in ms — the shape assertions read better this way. */
function offsets(startAt: Date, sends: readonly { scheduledAt: Date }[]): number[] {
  return sends.map((send) => send.scheduledAt.getTime() - startAt.getTime());
}

describe('minStepForHourlyLimit', () => {
  it('divides an hour exactly when the limit divides an hour', () => {
    expect(minStepForHourlyLimit(60)).toBe(60_000);
    expect(minStepForHourlyLimit(100)).toBe(36_000);
    expect(minStepForHourlyLimit(1)).toBe(HOUR_MS);
  });

  it('rounds up, never down', () => {
    // 3_600_000 / 7 = 514_285.714…  Rounding down to 514_285 would fit an
    // eighth send at 3_599_995 ms, inside the same hour.
    expect(minStepForHourlyLimit(7)).toBe(514_286);
    expect(minStepForHourlyLimit(7) * 7).toBeGreaterThan(HOUR_MS);
  });
});

describe('planSchedule', () => {
  it('puts a single recipient at startAt with no delay', () => {
    const plan = planSchedule({
      startAt: NOW,
      recipientCount: 1,
      delayBetweenEmailsMs: 0,
      now: NOW,
    });

    expect(plan.sends).toHaveLength(1);
    expect(offsets(NOW, plan.sends)).toEqual([0]);
    expect(plan.sends.map((s) => s.delayMs)).toEqual([0]);
    expect(plan.lastScheduledAt).toEqual(NOW);
    expect(plan.effectiveStepMs).toBe(0);
    expect(plan.widenedByHourlyLimit).toBe(false);
  });

  it('spaces sends by the requested delay', () => {
    const plan = planSchedule({
      startAt: NOW,
      recipientCount: 4,
      delayBetweenEmailsMs: 90_000,
      now: NOW,
    });

    expect(offsets(NOW, plan.sends)).toEqual([0, 90_000, 180_000, 270_000]);
    expect(plan.effectiveStepMs).toBe(90_000);
    expect(plan.lastScheduledAt.getTime()).toBe(NOW.getTime() + 270_000);
  });

  it('carries the wait until startAt into every delay', () => {
    const startAt = new Date(NOW.getTime() + 30 * 60_000);

    const plan = planSchedule({
      startAt,
      recipientCount: 3,
      delayBetweenEmailsMs: 1_000,
      now: NOW,
    });

    // scheduledAt is absolute; delayMs is relative to the one sampled `now`.
    expect(plan.sends.map((s) => s.delayMs)).toEqual([1_800_000, 1_801_000, 1_802_000]);
  });

  it('lets the hourly limit widen a delay that is too tight', () => {
    const plan = planSchedule({
      startAt: NOW,
      recipientCount: 3,
      delayBetweenEmailsMs: 1_000,
      hourlyLimit: 60,
      now: NOW,
    });

    expect(plan.effectiveStepMs).toBe(60_000);
    expect(plan.widenedByHourlyLimit).toBe(true);
    expect(offsets(NOW, plan.sends)).toEqual([0, 60_000, 120_000]);
  });

  it('keeps a delay that is already wider than the hourly limit requires', () => {
    const plan = planSchedule({
      startAt: NOW,
      recipientCount: 3,
      delayBetweenEmailsMs: 120_000,
      hourlyLimit: 60,
      now: NOW,
    });

    // max(), not sum(): 60/hour permits 60_000 ms, the caller asked for more.
    expect(plan.effectiveStepMs).toBe(120_000);
    expect(plan.widenedByHourlyLimit).toBe(false);
  });

  it('never exceeds the hourly limit in any 60-minute window', () => {
    // The property the `ceil` in minStepForHourlyLimit exists to guarantee.
    // Every one of these limits fails this assertion if `ceil` becomes `floor`.
    for (const hourlyLimit of [1, 2, 3, 7, 11, 13, 17, 23, 59, 60, 61, 97, 360, 3600]) {
      const plan = planSchedule({
        startAt: NOW,
        recipientCount: Math.min(hourlyLimit * 2 + 2, 500),
        delayBetweenEmailsMs: 0,
        hourlyLimit,
        now: NOW,
      });

      const instants = plan.sends.map((send) => send.scheduledAt.getTime());
      for (const windowStart of instants) {
        const inWindow = instants.filter(
          (at) => at >= windowStart && at < windowStart + HOUR_MS,
        ).length;
        expect(inWindow, `limit ${String(hourlyLimit)} from ${String(windowStart)}`).toBeLessThanOrEqual(hourlyLimit);
      }
    }
  });

  it('clamps delays to zero for a start time inside the grace window', () => {
    const startAt = new Date(NOW.getTime() - 60_000);

    const plan = planSchedule({
      startAt,
      recipientCount: 3,
      delayBetweenEmailsMs: 30_000,
      now: NOW,
    });

    // Absolute instants stay in the past; BullMQ delays cannot be negative.
    expect(offsets(startAt, plan.sends)).toEqual([0, 30_000, 60_000]);
    expect(plan.sends.map((s) => s.delayMs)).toEqual([0, 0, 0]);
  });

  it('rejects a start time older than the grace window', () => {
    expect(() =>
      planSchedule({
        startAt: new Date(NOW.getTime() - START_AT_GRACE_MS - 1),
        recipientCount: 1,
        delayBetweenEmailsMs: 0,
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'SchedulePlanError',
        reason: 'start_too_far_past',
      }) as Error,
    );
  });

  it('rejects a batch that would run past the horizon', () => {
    let thrown: unknown;
    try {
      planSchedule({
        startAt: NOW,
        recipientCount: 500,
        delayBetweenEmailsMs: 24 * HOUR_MS,
        now: NOW,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchedulePlanError);
    expect((thrown as SchedulePlanError).reason).toBe('horizon_exceeded');
    // 499 days requested against a 90-day ceiling.
    expect(499 * 24 * HOUR_MS).toBeGreaterThan(MAX_HORIZON_MS);
  });

  it('rejects an empty batch', () => {
    expect(() =>
      planSchedule({ startAt: NOW, recipientCount: 0, delayBetweenEmailsMs: 0, now: NOW }),
    ).toThrowError(expect.objectContaining({ reason: 'empty_batch' }) as Error);
  });
});
