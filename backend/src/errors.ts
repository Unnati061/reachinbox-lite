/**
 * HTTP errors that are safe to surface to a client.
 *
 * Anything thrown that is *not* an `HttpError` is treated as a bug by the error
 * middleware: logged with its stack, reported to the caller as a generic 500.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required'): HttpError {
    return new HttpError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Not allowed'): HttpError {
    return new HttpError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Resource not found'): HttpError {
    return new HttpError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, 'CONFLICT', message, details);
  }

  static unprocessable(message: string, details?: unknown): HttpError {
    return new HttpError(422, 'UNPROCESSABLE_ENTITY', message, details);
  }

  static tooManyRequests(message = 'Rate limit exceeded'): HttpError {
    return new HttpError(429, 'TOO_MANY_REQUESTS', message);
  }

  static internal(message = 'Internal server error'): HttpError {
    return new HttpError(500, 'INTERNAL_ERROR', message);
  }

  static serviceUnavailable(message: string, details?: unknown): HttpError {
    return new HttpError(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}

/**
 * Thrown by code paths that exist as structure but have no behaviour yet.
 * Preferred over a silent no-op: in a scheduler, a job that "succeeds" without
 * sending is worse than a job that fails loudly and retries.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
