import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { config } from './config/config.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { createRouter } from './routes/index.js';

/**
 * Builds the Express app without binding a port, so tests can drive it in
 * process and `index.ts` owns the listening/shutdown lifecycle.
 *
 * SECURITY: there is still no authentication layer, and as of this phase that
 * is no longer harmless. `/api/emails/*` lets any caller who can reach the port
 * send mail as any registered sender, and read every recipient address, subject
 * and error in the database. It is bound to localhost in development and CORS
 * limits browsers, but CORS does not limit curl. Auth must land before this is
 * exposed to anything but a local dev machine.
 */
export function createApp(): Express {
  const app = express();

  // Express advertises itself in a response header by default.
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      // Spread: config holds a readonly array, cors wants a mutable one.
      origin: [...config.http.corsOrigins],
      credentials: true,
    }),
  );

  // Scheduled emails carry bodies, but not megabytes of them.
  app.use(express.json({ limit: '256kb' }));

  app.use(requestLogger);
  app.use(createRouter());

  // Order matters: unmatched route -> 404, then the terminal error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
