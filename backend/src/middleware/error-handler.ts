import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../errors.js';
import { logger } from '../logger.js';

/** The single error shape every endpoint returns. Mirrored in frontend/types/api.ts. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

function requestId(req: Request): string | undefined {
  const id: unknown = req.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Terminal error middleware. Must stay last in the stack, and must keep four
 * parameters — Express identifies error handlers by arity.
 *
 * Known failures (`HttpError`, `ZodError`) are reported as-is. Anything else is
 * a bug: it is logged with its stack and reduced to a generic 500 so internals
 * never reach a client.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response<ApiErrorBody>,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // Too late for a JSON body; let Express tear the connection down.
    next(error);
    return;
  }

  const log = req.log ?? logger;
  const id = requestId(req);

  if (error instanceof HttpError) {
    log.warn({ err: error, code: error.code, status: error.status }, 'Request failed');
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(id !== undefined ? { requestId: id } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    log.warn({ err: error }, 'Request validation failed');
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        ...(id !== undefined ? { requestId: id } : {}),
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  log.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      ...(id !== undefined ? { requestId: id } : {}),
    },
  });
}
