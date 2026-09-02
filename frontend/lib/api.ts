import type {
  ApiErrorBody,
  HealthResponse,
  PaginatedResponse,
  ReadinessResponse,
  ScheduleBatchResponse,
  ScheduledEmailListItem,
} from '@/types/api';

/**
 * Typed fetch client for the ReachInbox-lite API.
 *
 * Every call funnels through `request()` so that base URL, JSON encoding,
 * timeouts and the error envelope are handled in exactly one place. Components
 * should call the named helpers at the bottom of this file, not fetch directly —
 * that keeps response types tied to `types/api.ts` instead of `any`.
 */

/**
 * Inlined into the browser bundle at build time, so this must never hold a
 * secret. Read via a direct `process.env.NEXT_PUBLIC_*` reference: Next only
 * substitutes the literal form, not a dynamic lookup.
 */
const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

/** A request that hangs forever is a worse UX than one that fails. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Sentinel code used when the failure never reached the API (DNS, offline, abort). */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
/** Sentinel code used when the API answered with something other than our envelope. */
export const MALFORMED_ERROR_CODE = 'MALFORMED_RESPONSE';

/**
 * Thrown for every non-2xx response and for transport failures.
 *
 * `status` is 0 when the request never got an HTTP response, which lets callers
 * distinguish "server said no" from "server unreachable" without string matching.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    status: number;
    code: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.details = args.details;
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  /** Query parameters; entries with `undefined`/`null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Serialised as JSON. Use `undefined` for bodyless methods. */
  body?: unknown;
  /** Overrides `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Caller-owned cancellation (e.g. React effect cleanup); combined with the timeout. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Passed through to fetch — `no-store` on reads that must not be cached. */
  cache?: RequestCache;
  /**
   * Non-2xx statuses whose body is still a valid typed response rather than an
   * error envelope. Readiness is the motivating case: 503 with a per-dependency
   * report is a normal answer, not a failure.
   */
  acceptStatuses?: readonly number[];
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  if (BASE_URL === '') {
    throw new ApiError({
      message:
        'NEXT_PUBLIC_API_BASE_URL is not set. Copy frontend/.env.example to frontend/.env.local.',
      status: 0,
      code: 'CONFIG_ERROR',
    });
  }

  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Pull `{ error: { code, message } }` out of a failed response, tolerating garbage. */
function toApiError(status: number, payload: unknown, fallback: string): ApiError {
  const envelope = (payload as ApiErrorBody | null)?.error;
  if (envelope && typeof envelope.code === 'string' && typeof envelope.message === 'string') {
    return new ApiError({
      message: envelope.message,
      status,
      code: envelope.code,
      requestId: envelope.requestId,
      details: envelope.details,
    });
  }
  return new ApiError({ message: fallback, status, code: MALFORMED_ERROR_CODE, details: payload });
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    body,
    headers,
    query,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cache,
    acceptStatuses,
  } = options;
  const url = buildUrl(path, query);

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: combined,
      cache: cache ?? 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    // fetch rejects for aborts and transport failures; neither has an HTTP status.
    const aborted = cause instanceof DOMException && cause.name === 'AbortError';
    const timedOut = aborted && timeout.aborted;
    throw new ApiError({
      message: timedOut
        ? `Request to ${method} ${path} timed out after ${String(timeoutMs)}ms`
        : aborted
          ? `Request to ${method} ${path} was cancelled`
          : `Could not reach the API at ${BASE_URL}`,
      status: 0,
      code: NETWORK_ERROR_CODE,
      details: cause instanceof Error ? cause.message : cause,
    });
  }

  if (response.status === 204) return undefined as T;

  const raw = await response.text();
  let payload: unknown = null;
  if (raw !== '') {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok && !(acceptStatuses?.includes(response.status) ?? false)) {
    throw toApiError(response.status, payload, `${method} ${path} failed (${response.status})`);
  }

  return payload as T;
}

/**
 * Endpoint map. Health sits outside `/api` deliberately (see backend
 * routes/index.ts) — probes should not have to know anything about the API
 * surface. Domain calls belong under `API_BASE`.
 *
 * There is no version segment: the backend dropped its unmounted `/api/v1`
 * constant in favour of the `/api` the routes are actually served from. A
 * version in the client that the server does not answer on is worse than none.
 */
export const API_BASE = '/api';

export const api = {
  health: (options?: RequestOptions) => request<HealthResponse>('GET', '/health', options),
  readiness: (options?: RequestOptions) =>
    request<ReadinessResponse>('GET', '/health/ready', { ...options, acceptStatuses: [503] }),
  scheduled: (options?: RequestOptions) =>
    request<PaginatedResponse<ScheduledEmailListItem>>(
      'GET',
      `${API_BASE}/emails/scheduled`,
      options,
    ),
  sent: (options?: RequestOptions) =>
    request<PaginatedResponse<ScheduledEmailListItem>>('GET', `${API_BASE}/emails/sent`, options),
  schedule: (body: {
    sender: string;
    subject: string;
    body: string;
    recipients: string[];
    start_time: string;
    delay_between_emails_ms: number;
    hourly_limit?: number;
  }) => request<ScheduleBatchResponse>('POST', `${API_BASE}/emails/schedule`, { body }),
} as const;
