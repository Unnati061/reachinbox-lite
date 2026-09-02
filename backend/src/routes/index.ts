import { Router } from 'express';
import { emailRouter } from './email.routes.js';
import { healthRouter } from './health.routes.js';
import { queueRouter } from './queue.routes.js';
import { slackRouter } from './slack.routes.js';

/**
 * Base path for domain endpoints.
 *
 * Unversioned, replacing the `/api/v1` constant this file used to export.
 * That constant was never mounted anywhere, and the endpoints this project
 * actually specifies are `/api/emails/...`. A version segment that only exists
 * in a dead constant is worse than none: it implies a versioning policy that
 * nothing implements. When a breaking change is real, `/api/v2` can be mounted
 * beside `/api` and both served.
 */
export const API_BASE = '/api';

/**
 * Root router.
 *
 * Health sits outside `API_BASE` — probes should not have to track API paths.
 */
export function createRouter(): Router {
  const router = Router();

  router.use('/health', healthRouter);
  router.use(`${API_BASE}/emails`, emailRouter);
  router.use('/admin/queues', queueRouter);
  router.use(`${API_BASE}/integrations/slack`, slackRouter);

  return router;
}
