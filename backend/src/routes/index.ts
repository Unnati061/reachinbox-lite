import { Router } from 'express';
import { healthRouter } from './health.routes.js';

/**
 * Root router.
 *
 * Health lives outside the version prefix — probes should not have to follow
 * API versioning. Domain routers (campaigns, schedules, recipients) mount under
 * `/api/v1` as they are built.
 */
export function createRouter(): Router {
  const router = Router();

  router.use('/health', healthRouter);

  return router;
}

export const API_PREFIX = '/api/v1';
