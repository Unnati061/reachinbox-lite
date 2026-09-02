/**
 * The scheduling math, deliberately isolated from Express, Prisma and BullMQ.
 *
 * Everything here is pure: given the same input it returns the same plan, with
 * no clock reads (the caller passes `now`) and no I/O. That is what lets the
 * unit tests cover it with Postgres and Redis down — a property Phase 1
 * committed to and DECISIONS.md records.
 */

/** One hour in milliseconds. The unit `hourlyLimit` is denominated in. */
export const HOUR_MS = 3_600_000;

/**
 * How far into the past a caller-supplied `start_time` may be before it is
 * rejected rather than clamped.
 *
 * Zero tolerance is wrong: a client that computes "now" and spends 200 ms in
 * DNS, TLS and JSON would have its request refused. Five minutes absorbs
 * ordinary clock skew between a browser and a server without silently
 * back-dating a campaign someone meant to run next week.
 */
export const START_AT_GRACE_MS = 5 * 60_000;

/**
 * Longest schedule the planner will produce, measured from `startAt` to the
 * final send. A guard against a mistyped delay (`600000` for ten minutes vs
 * `6000000` for one hour forty) quietly booking sends into next year.
 */
export const MAX_HORIZON_MS = 90 * 24 * HOUR_MS;

export interface SchedulePlanInput {
  /** When the first email should go out. */
  readonly startAt: Date;
  /** How many recipients the batch has. Must be >= 1. */
  readonly recipientCount: number;
  /** Requested spacing between consecutive sends. */
  readonly delayBetweenEmailsMs: number;
  /** Optional cap on sends per rolling hour, per sender. */
  readonly hourlyLimit?: number | undefined;
  /** Reference instant for BullMQ delays. Sampled once by the caller. */
  readonly now: Date;
}

export interface PlannedSend {
  /** Position in the batch, 0-based. */
  readonly index: number;
  /** Absolute instant this email should be sent. */
  readonly scheduledAt: Date;
  /** What BullMQ needs: milliseconds from `now` until `scheduledAt`, never negative. */
  readonly delayMs: number;
}

export interface SchedulePlan {
  readonly startAt: Date;
  /** Spacing actually applied — see `planSchedule` for how it is derived. */
  readonly effectiveStepMs: number;
  /** True when `hourlyLimit`, not `delayBetweenEmailsMs`, set the spacing. */
  readonly widenedByHourlyLimit: boolean;
  readonly sends: readonly PlannedSend[];
  /** Instant of the last send; equals `startAt` for a single recipient. */
  readonly lastScheduledAt: Date;
}

/** Raised for inputs that are well-formed but cannot be scheduled. */
export class SchedulePlanError extends Error {
  readonly reason: 'start_too_far_past' | 'horizon_exceeded' | 'empty_batch';

  constructor(reason: SchedulePlanError['reason'], message: string) {
    super(message);
    this.name = 'SchedulePlanError';
    this.reason = reason;
  }
}

/**
 * Smallest spacing that keeps a rolling hour under `hourlyLimit`.
 *
 * `ceil`, not exact division, and the difference is not cosmetic. Take
 * `hourlyLimit = 7`: 3_600_000 / 7 = 514_285.71.
 *
 *   - floor -> 514_285 ms. Sends land at 0, 514_285, ... , 7 * 514_285 =
 *     3_599_995 ms, which is still inside the first hour. That is 8 sends in
 *     60 minutes with a limit of 7.
 *   - ceil  -> 514_286 ms. The 8th send lands at 3_600_002 ms, just outside.
 *     Exactly 7 sends in any 60-minute window.
 *
 * Rounding down breaks the cap for every limit that does not divide an hour
 * evenly, which is most of them.
 */
export function minStepForHourlyLimit(hourlyLimit: number): number {
  return Math.ceil(HOUR_MS / hourlyLimit);
}

/**
 * Turn one request into per-email instants and BullMQ delays.
 *
 * The whole schedule is a single arithmetic progression:
 *
 *   effectiveStepMs = max(delayBetweenEmailsMs, ceil(HOUR_MS / hourlyLimit))
 *   scheduledAt(i)  = startAt + i * effectiveStepMs
 *   delayMs(i)      = max(0, scheduledAt(i) - now)
 *
 * Two things are worth spelling out.
 *
 * The two throttles are combined with `max` rather than added: they express the
 * same constraint at different resolutions, so the tighter one wins. Adding
 * them would make `delay=1000, hourlyLimit=60` produce 61-second gaps, which is
 * neither what was asked for nor what the cap requires.
 *
 * `delayMs` is relative because that is BullMQ's interface, and it is computed
 * against a single `now` for the entire batch. Sampling the clock per email
 * would let a slow loop drift the spacing: email 0 measured at T and email 400
 * at T+80ms yields gaps that are subtly short. One sample keeps the
 * progression exact, and `scheduledAt` — an absolute instant — stays the
 * source of truth if a job is ever re-enqueued.
 */
export function planSchedule(input: SchedulePlanInput): SchedulePlan {
  const { startAt, recipientCount, delayBetweenEmailsMs, hourlyLimit, now } = input;

  if (recipientCount < 1) {
    throw new SchedulePlanError('empty_batch', 'A batch needs at least one recipient');
  }

  if (startAt.getTime() < now.getTime() - START_AT_GRACE_MS) {
    throw new SchedulePlanError(
      'start_too_far_past',
      `start_time is more than ${String(START_AT_GRACE_MS / 60_000)} minutes in the past`,
    );
  }

  const limitStepMs = hourlyLimit === undefined ? 0 : minStepForHourlyLimit(hourlyLimit);
  const effectiveStepMs = Math.max(delayBetweenEmailsMs, limitStepMs);

  const horizonMs = (recipientCount - 1) * effectiveStepMs;
  if (horizonMs > MAX_HORIZON_MS) {
    throw new SchedulePlanError(
      'horizon_exceeded',
      `This batch would take ${String(Math.round(horizonMs / (24 * HOUR_MS)))} days to send, ` +
        `over the ${String(MAX_HORIZON_MS / (24 * HOUR_MS))}-day maximum. ` +
        'Reduce the recipient count, the delay, or raise the hourly limit.',
    );
  }

  const startMs = startAt.getTime();
  const nowMs = now.getTime();
  const sends: PlannedSend[] = [];

  for (let index = 0; index < recipientCount; index += 1) {
    const at = startMs + index * effectiveStepMs;
    sends.push({
      index,
      scheduledAt: new Date(at),
      // Clamped: a start_time inside the grace window is in the past, and
      // BullMQ treats a negative delay as an error rather than as "now".
      delayMs: Math.max(0, at - nowMs),
    });
  }

  return {
    startAt: new Date(startMs),
    effectiveStepMs,
    widenedByHourlyLimit: limitStepMs > delayBetweenEmailsMs,
    sends,
    lastScheduledAt: new Date(startMs + (recipientCount - 1) * effectiveStepMs),
  };
}
