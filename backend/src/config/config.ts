/**
 * Startup configuration.
 *
 * Importing this module loads `backend/.env` and validates it. If anything is
 * missing or malformed the process throws immediately with every problem
 * listed — the API never boots half-configured and then fails on the first
 * request that happens to touch the missing value.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnv } from './env.js';
import type { AppConfig } from './env.js';

// Resolved from this module, not from `process.cwd()`, so `npm run dev` from
// the repo root and `node dist/index.js` from backend/ read the same file.
// dist/config/config.js -> dist/config -> dist -> backend/.env
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export const config: AppConfig = loadEnv(process.env);

export type { AppConfig } from './env.js';
export { EnvValidationError, loadEnv } from './env.js';
