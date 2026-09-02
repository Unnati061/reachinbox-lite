import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../logger.js';

/**
 * Per-request logging.
 *
 * Every request gets an id (an inbound `x-request-id` is honoured so a trace
 * survives a proxy) and it is echoed back on the response, which is what error
 * bodies reference. Liveness probes are not logged — they would otherwise be
 * most of the log volume.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const header = req.headers['x-request-id'];
    const inbound = Array.isArray(header) ? header[0] : header;
    const id = inbound !== undefined && inbound.length > 0 ? inbound : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (_req, res, error) => {
    if (error !== undefined || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
});
