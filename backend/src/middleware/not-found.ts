import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors.js';

/**
 * Catch-all for unmatched routes. Mounted after every router and before
 * {@link errorHandler} so a 404 comes back in the same envelope as any other
 * error rather than Express's HTML default.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(HttpError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
}
