import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ApiErrorBody } from '../src/middleware/error-handler.js';

const app = createApp();

describe('API wiring', () => {
  it('answers liveness without touching a datastore', async () => {
    const response = await request(app).get('/health');
    const body = response.body as { status: string; uptimeSeconds: number };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('returns the shared error envelope for an unknown route', async () => {
    const response = await request(app).get('/nope');
    const body = response.body as ApiErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/nope');
    expect(body.error.requestId).toBeTypeOf('string');
  });

  it('echoes an inbound request id so traces survive a proxy', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'trace-me-42');

    expect(response.headers['x-request-id']).toBe('trace-me-42');
  });

  it('sets the helmet baseline security headers', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
