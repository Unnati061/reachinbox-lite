/**
 * Runs before any test module is imported.
 *
 * These assignments happen before `src/config/config.ts` calls dotenv, and
 * dotenv does not overwrite variables that already exist — so tests always use
 * these values and can never be pointed at a real database by a stray .env.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/reachinbox_test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.CORS_ORIGIN = 'http://localhost:3000';
