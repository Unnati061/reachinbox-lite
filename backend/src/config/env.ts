/**
 * Environment schema and validation.
 *
 * Pure on purpose: no dotenv, no reading `process.env` at import time, no
 * side effects. That keeps it unit-testable and lets `config.ts` own the
 * "load .env and fail fast at startup" behaviour.
 */
import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

/** `.env` files produce empty strings for unset keys; treat those as absent. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().min(1).optional());
const optionalPort = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().min(1).max(65_535).optional(),
);
const positiveInteger = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
const nonNegativeInteger = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  REDIS_URL: z
    .string()
    .min(1)
    .regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// connection string'),

  /** Comma-separated list of browser origins allowed to call this API. */
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  // Optional until the sending phase. The worker checks `mail.isConfigured`
  // and refuses the job rather than reporting a send that never happened.
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalPort,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  MAIL_FROM: optionalString,
  /** Optional so a developer can run the core scheduler without search. */
  ELASTICSEARCH_URL: z.preprocess(
    blankToUndefined,
    z.string().url('must be a valid Elasticsearch URL').optional(),
  ),
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_REDIRECT_URI: z.preprocess(
    blankToUndefined,
    z.string().url().default('http://localhost:4000/api/integrations/slack/callback'),
  ),

  // Delivery controls live in configuration, not code. They apply to every
  // worker process that shares this application's Redis instance.
  WORKER_CONCURRENCY: positiveInteger(5),
  MIN_SEND_INTERVAL_MS: nonNegativeInteger(2_000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: positiveInteger(200),
});

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isDevelopment: boolean;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly http: {
    readonly port: number;
    readonly corsOrigins: readonly string[];
  };
  readonly log: { readonly level: LogLevel };
  readonly db: { readonly url: string };
  readonly redis: { readonly url: string };
  readonly mail: {
    readonly isConfigured: boolean;
    readonly host: string | undefined;
    readonly port: number | undefined;
    readonly user: string | undefined;
    readonly password: string | undefined;
    readonly from: string | undefined;
  };
  readonly search: { readonly elasticsearchUrl: string | undefined };
  readonly slack: {
    readonly isConfigured: boolean;
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly redirectUri: string;
  };
  readonly delivery: {
    readonly workerConcurrency: number;
    readonly minSendIntervalMs: number;
    readonly maxEmailsPerHourPerSender: number;
  };
}

export interface EnvIssue {
  readonly key: string;
  readonly problem: string;
}

/**
 * Never print the offending value for these keys — a startup crash usually
 * ends up in a log aggregator, a CI transcript or a screenshot.
 */
const SENSITIVE_KEY = /PASSWORD|SECRET|TOKEN|CREDENTIAL|KEY|URL|DSN/i;

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(EnvValidationError.format(issues));
    this.name = 'EnvValidationError';
    this.issues = issues;
  }

  private static format(issues: readonly EnvIssue[]): string {
    const width = Math.max(...issues.map((issue) => issue.key.length));
    const lines = issues.map((issue) => `  ${issue.key.padEnd(width)}  ${issue.problem}`);
    return [
      `Invalid environment configuration — the API refused to start (${issues.length} problem${
        issues.length === 1 ? '' : 's'
      }):`,
      '',
      ...lines,
      '',
      'Fix backend/.env (start from backend/.env.example) and try again.',
    ].join('\n');
  }
}

/**
 * Validate a raw environment bag into an {@link AppConfig}.
 *
 * @throws {EnvValidationError} listing every problem at once, so one restart
 * surfaces all of them instead of one per attempt.
 */
export function loadEnv(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue): EnvIssue => {
      const key = String(issue.path[0] ?? '<root>');
      const raw = source[key];
      if (raw === undefined || raw.trim() === '') {
        return { key, problem: 'missing (required)' };
      }
      const shown = SENSITIVE_KEY.test(key) ? '<redacted>' : JSON.stringify(raw);
      return { key, problem: `${issue.message} (received ${shown})` };
    });
    throw new EnvValidationError(issues);
  }

  const env = result.data;
  const corsOrigins = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    nodeEnv: env.NODE_ENV,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    http: { port: env.PORT, corsOrigins },
    log: { level: env.LOG_LEVEL },
    db: { url: env.DATABASE_URL },
    redis: { url: env.REDIS_URL },
    mail: {
      isConfigured: env.SMTP_HOST !== undefined && env.MAIL_FROM !== undefined,
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    },
    search: { elasticsearchUrl: env.ELASTICSEARCH_URL },
    slack: {
      isConfigured: env.SLACK_CLIENT_ID !== undefined && env.SLACK_CLIENT_SECRET !== undefined,
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
      redirectUri: env.SLACK_REDIRECT_URI,
    },
    delivery: {
      workerConcurrency: env.WORKER_CONCURRENCY,
      minSendIntervalMs: env.MIN_SEND_INTERVAL_MS,
      maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
  };
}
