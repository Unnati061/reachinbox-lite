import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/config/env.js';

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://reachinbox:pw@localhost:5432/reachinbox_dev?schema=public',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const config = loadEnv(validEnv);

    expect(config.nodeEnv).toBe('development');
    expect(config.http.port).toBe(4000);
    expect(config.log.level).toBe('info');
    expect(config.http.corsOrigins).toEqual(['http://localhost:3000']);
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  it('reports every missing variable in one throw', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);

    try {
      loadEnv({});
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const keys = (error as EnvValidationError).issues.map((issue) => issue.key);
      expect(keys).toContain('DATABASE_URL');
      expect(keys).toContain('REDIS_URL');
      expect((error as Error).message).toContain('missing (required)');
      expect((error as Error).message).toContain('backend/.env');
    }
  });

  it('never echoes a secret value in the error message', () => {
    const attempt = (): unknown =>
      loadEnv({ ...validEnv, DATABASE_URL: 'mysql://user:hunter2-do-not-leak@host/db' });

    expect(attempt).toThrow(EnvValidationError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2-do-not-leak');
      expect((error as Error).message).toContain('<redacted>');
    }
  });

  it('rejects a non-numeric PORT and shows the offending value', () => {
    try {
      loadEnv({ ...validEnv, PORT: 'not-a-port' });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('PORT');
      expect((error as Error).message).toContain('not-a-port');
    }
  });

  it('splits CORS_ORIGIN into a trimmed list', () => {
    const config = loadEnv({
      ...validEnv,
      CORS_ORIGIN: 'http://localhost:3000, https://app.example.com ',
    });

    expect(config.http.corsOrigins).toEqual(['http://localhost:3000', 'https://app.example.com']);
  });

  it('treats blank optional values as absent', () => {
    const config = loadEnv({ ...validEnv, SMTP_HOST: '', SMTP_PORT: '', MAIL_FROM: '  ' });

    expect(config.mail.host).toBeUndefined();
    expect(config.mail.port).toBeUndefined();
    expect(config.mail.isConfigured).toBe(false);
  });

  it('marks mail as configured once host and sender are present', () => {
    const config = loadEnv({
      ...validEnv,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      MAIL_FROM: 'hello@example.com',
    });

    expect(config.mail.isConfigured).toBe(true);
    expect(config.mail.port).toBe(587);
  });
});
