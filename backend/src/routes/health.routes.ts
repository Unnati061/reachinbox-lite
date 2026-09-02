import { Router } from 'express';
import { getReadiness } from '../services/health.service.js';

export const healthRouter = Router();

/**
 * Liveness — is the process up? Touches no dependency on purpose: a database
 * outage must not make an orchestrator kill an otherwise healthy process.
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness — can it serve traffic? Probes Postgres and Redis and answers 503
 * when either is down, with the per-dependency detail in the body.
 *
 * Express 5 forwards rejected promises to the error middleware, so no try/catch.
 */
healthRouter.get('/ready', async (_req, res) => {
  const report = await getReadiness();
  res.status(report.ready ? 200 : 503).json(report);
});
