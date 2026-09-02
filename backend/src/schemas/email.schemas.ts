/**
 * Request validation for the email endpoints.
 *
 * The wire format is snake_case in both directions. The brief specifies
 * snake_case request fields, and answering with camelCase would mean a client
 * writing `delay_between_emails_ms` and reading `delayBetweenEmailsMs` for the
 * same concept. Serialisers in email.serializers.ts do the mapping, which also
 * keeps Postgres column names from leaking into the API contract.
 */

import { z } from 'zod';

/**
 * Per-request recipient cap. Not a product limit — a request-size limit. The
 * planner is happy with more; a single HTTP request that fans out to tens of
 * thousands of rows is a different feature (an upload with a job to expand it).
 */
export const MAX_RECIPIENTS = 500;

/** RFC 5322 caps a header line at 998 octets, and a subject is one line. */
const MAX_SUBJECT_LENGTH = 998;

/**
 * 100k characters is a very long email. `express.json({ limit: '256kb' })` in
 * app.ts is the real backstop; this exists to fail with a field-level message
 * instead of a bare 413.
 */
const MAX_BODY_LENGTH = 100_000;

/** 24 hours. Longer gaps between two emails are a campaign, not a delay. */
const MAX_DELAY_MS = 24 * 60 * 60 * 1_000;

const MAX_HOURLY_LIMIT = 10_000;

/** Ceiling on `per_page`, so one caller cannot ask for the whole table. */
export const MAX_PER_PAGE = 100;

const DEFAULT_PER_PAGE = 25;

/**
 * An email address, normalised on the way in.
 *
 * Trimmed and lowercased before validation, so `" Ada@Example.com "` and
 * `"ada@example.com"` are the same recipient. The local part of an address is
 * technically case-sensitive, but no mail provider in practice treats it that
 * way, and case-preserving would mean either a case-insensitive index or
 * duplicate sends to the same human.
 */
const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'must be a valid email address' }).max(320));

/**
 * A single recipient or a list of them, always producing a list.
 *
 * Duplicates are not removed here: the endpoint reports how many it dropped,
 * and that is domain behaviour rather than validation.
 */
const recipientList = z
  .union([emailAddress, z.array(emailAddress)])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .pipe(
    z
      .array(z.string())
      .min(1, { error: 'at least one recipient is required' })
      .max(MAX_RECIPIENTS, { error: `at most ${String(MAX_RECIPIENTS)} recipients per request` }),
  );

/**
 * An instant, not a wall-clock reading. A timezone is mandatory: `start_time`
 * decides when mail leaves the building, and "2026-09-02T09:00:00" means five
 * different moments depending on who parses it.
 */
const isoInstant = z.iso
  .datetime({
    offset: true,
    error: 'must be an ISO-8601 timestamp including a timezone, e.g. 2026-09-02T14:30:00Z',
  })
  .transform((value) => new Date(value));

/**
 * How the caller names the From identity: either the sender's UUID or its email
 * address. Both are unique, and a client that just created a sender has the id
 * while a script written by hand has the address.
 */
const senderReference = z.union([
  z.uuid().transform((value) => ({ kind: 'id' as const, value })),
  emailAddress.transform((value) => ({ kind: 'email' as const, value })),
]);

export type SenderReference = z.output<typeof senderReference>;

/**
 * POST /api/emails/schedule.
 *
 * Strict: an unknown key is a 400, not a shrug. `hourly_limits` instead of
 * `hourly_limit` silently ignored is the difference between a throttled warm-up
 * and blasting 500 emails in one second from a cold domain.
 */
export const scheduleEmailsBodySchema = z
  .strictObject({
    sender: senderReference,
    subject: z
      .string()
      .trim()
      .min(1, { error: 'subject cannot be empty' })
      .max(MAX_SUBJECT_LENGTH),
    body: z
      .string()
      .min(1, { error: 'body cannot be empty' })
      .max(MAX_BODY_LENGTH)
      .refine((value) => value.trim().length > 0, { error: 'body cannot be only whitespace' }),
    recipients: recipientList,
    /** Defaults to "now" in the service, which also owns the clock. */
    start_time: isoInstant.optional(),
    delay_between_emails_ms: z.number().int().min(0).max(MAX_DELAY_MS).optional(),
    hourly_limit: z.number().int().min(1).max(MAX_HOURLY_LIMIT).optional(),
  })
  .superRefine((value, ctx) => {
    // Required for a real batch, pointless for one recipient. Defaulting it to
    // 0 instead would turn a forgotten field into an unthrottled send.
    if (value.recipients.length > 1 && value.delay_between_emails_ms === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['delay_between_emails_ms'],
        message: 'required when there is more than one recipient',
      });
    }
  });

export type ScheduleEmailsBody = z.output<typeof scheduleEmailsBodySchema>;

/**
 * Query string for both list endpoints.
 *
 * Not strict, unlike the body above. An ignored `?utm_source=` is harmless,
 * whereas an ignored body field changes what gets sent.
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  per_page: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
});

export type ListQuery = z.output<typeof listQuerySchema>;
