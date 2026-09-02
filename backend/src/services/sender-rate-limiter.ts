/**
 * Cross-worker sender throttle.
 *
 * A Redis sorted set stores one reservation per dispatch attempt, scored by
 * the current millisecond. The Lua script makes trim/count/reserve one atomic
 * operation, so concurrent workers cannot both observe the final free slot.
 */
import { getRedis } from '../db/redis.js';

const HOUR_MS = 60 * 60 * 1_000;
const KEY_PREFIX = 'reachinbox:sender-send-attempts:';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Zero when allowed; otherwise the earliest instant this job may retry. */
  readonly retryAt: Date | null;
}

// KEYS[1] sender sorted-set; ARGV = now, window, cap, unique reservation id.
const RESERVE_SEND_SLOT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local used = redis.call('ZCARD', KEYS[1])
if used >= cap then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]
  return {0, tonumber(oldest) + window}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return {1, 0}
`;

function keyFor(senderId: string): string {
  return `${KEY_PREFIX}${senderId}`;
}

/**
 * Reserve one provider-send attempt in a rolling one-hour sender window.
 *
 * Attempts—not only accepted SMTP messages—are counted because SMTP providers
 * throttle connection/recipient attempts too. A transient failure therefore
 * cannot create an unlimited retry storm that bypasses the provider guardrail.
 */
export async function reserveSenderSendSlot(args: {
  senderId: string;
  reservationId: string;
  hourlyLimit: number;
  now?: Date;
}): Promise<RateLimitDecision> {
  const now = args.now ?? new Date();
  const raw = await getRedis().eval(
    RESERVE_SEND_SLOT,
    1,
    keyFor(args.senderId),
    String(now.getTime()),
    String(HOUR_MS),
    String(args.hourlyLimit),
    args.reservationId,
  );

  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== 'number' ||
    typeof raw[1] !== 'number'
  ) {
    throw new Error('Unexpected Redis sender rate-limit response');
  }

  return raw[0] === 1
    ? { allowed: true, retryAt: null }
    : { allowed: false, retryAt: new Date(raw[1]) };
}
