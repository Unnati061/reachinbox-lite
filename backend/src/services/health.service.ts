import { prisma } from '../db/client.js';
import { getRedis } from '../db/redis.js';

export type DependencyName = 'postgres' | 'redis';
export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  readonly name: DependencyName;
  readonly status: DependencyStatus;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly dependencies: readonly DependencyCheck[];
}

/** A readiness probe must answer quickly; a hung socket is a "down", not a wait. */
const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not respond within ${CHECK_TIMEOUT_MS}ms`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Keeps one dependency's failure from dominating the response body. */
const MAX_ERROR_LENGTH = 300;

/**
 * Render a thrown non-Error without producing "[object Object]".
 *
 * Rare, but drivers do occasionally reject with a plain object, and a health
 * report that says "[object Object]" is worse than one that says nothing.
 */
function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? 'unknown error';
  } catch {
    // Circular structure, or a BigInt inside an object.
    return 'unserialisable error value';
  }
}

/**
 * Flatten an error and its `cause` chain into one useful line.
 *
 * Prisma 7 wraps driver-adapter failures in an error whose own message is nearly
 * empty ("Invalid `prisma.$queryRaw()` invocation:") and puts the actual reason —
 * ECONNREFUSED, authentication failed, no such database — on `cause`. A readiness
 * report built from the outer message alone cannot tell "Postgres is not running"
 * from "wrong password", which is the whole point of reporting per dependency.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);

    if (!(current instanceof Error)) {
      parts.push(stringifyUnknown(current));
      break;
    }

    // pg and ioredis both put a machine-readable code on the error object.
    const { code } = current as Error & { code?: unknown };
    const suffix =
      typeof code === 'string' || typeof code === 'number' ? ` [${String(code)}]` : '';
    parts.push(`${current.message}${suffix}`);
    current = current.cause;
  }

  // Collapse the newlines Prisma pads its messages with — this ends up in JSON.
  const flattened = parts
    .join(' <- ')
    .replace(/\s+/g, ' ')
    .trim();

  if (flattened === '') return 'unknown error';
  return flattened.length > MAX_ERROR_LENGTH
    ? `${flattened.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : flattened;
}

async function probe(
  name: DependencyName,
  operation: () => Promise<unknown>,
): Promise<DependencyCheck> {
  const startedAt = performance.now();
  try {
    await withTimeout(operation, name);
    return { name, status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      name,
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(error),
    };
  }
}

/**
 * Readiness: can this process actually serve traffic right now?
 *
 * Both datastores are probed in parallel and reported individually, so a 503
 * says *which* dependency is missing instead of just "not ready".
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const dependencies = await Promise.all([
    probe('postgres', () => prisma.$queryRaw`SELECT 1`),
    probe('redis', () => getRedis().ping()),
  ]);

  return {
    ready: dependencies.every((dependency) => dependency.status === 'up'),
    dependencies,
  };
}
