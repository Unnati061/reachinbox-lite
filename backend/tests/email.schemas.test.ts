import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPIENTS,
  listQuerySchema,
  scheduleEmailsBodySchema,
} from '../src/schemas/email.schemas.js';

/** Minimal valid body; individual tests override one field at a time. */
const validBody = {
  sender: 'ada@example.com',
  subject: 'Hello',
  body: 'Body text',
  recipients: ['one@example.com'],
};

/** Collects `path: message` pairs so assertions name the field that failed. */
function issuePaths(input: unknown): string[] {
  const result = scheduleEmailsBodySchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('scheduleEmailsBodySchema', () => {
  it('accepts a minimal single-recipient body', () => {
    const parsed = scheduleEmailsBodySchema.parse(validBody);

    expect(parsed.recipients).toEqual(['one@example.com']);
    expect(parsed.sender).toEqual({ kind: 'email', value: 'ada@example.com' });
    expect(parsed.start_time).toBeUndefined();
    expect(parsed.delay_between_emails_ms).toBeUndefined();
  });

  it('wraps a bare recipient string into a list', () => {
    const parsed = scheduleEmailsBodySchema.parse({
      ...validBody,
      recipients: 'solo@example.com',
    });

    expect(parsed.recipients).toEqual(['solo@example.com']);
  });

  it('trims and lowercases addresses so duplicates collapse later', () => {
    const parsed = scheduleEmailsBodySchema.parse({
      ...validBody,
      sender: '  Ada@Example.COM ',
      recipients: ['  ONE@Example.com', 'one@example.com'],
      delay_between_emails_ms: 0,
    });

    expect(parsed.sender).toEqual({ kind: 'email', value: 'ada@example.com' });
    // Both normalise to the same address; the service is what drops the repeat.
    expect(parsed.recipients).toEqual(['one@example.com', 'one@example.com']);
  });

  it('reads a UUID sender as an id rather than an address', () => {
    const parsed = scheduleEmailsBodySchema.parse({
      ...validBody,
      sender: '3f2b6c62-0d4f-4b3a-9a1e-9a2f4c8d1e77',
    });

    expect(parsed.sender).toEqual({
      kind: 'id',
      value: '3f2b6c62-0d4f-4b3a-9a1e-9a2f4c8d1e77',
    });
  });

  it('rejects an unknown key instead of ignoring it', () => {
    // `hourly_limits` silently dropped is the difference between a throttled
    // warm-up and 500 emails in one second.
    const result = scheduleEmailsBodySchema.safeParse({ ...validBody, hourly_limits: 10 });

    expect(result.success).toBe(false);
    // Zod reports this at the object level, so the offending key is in the
    // issue rather than in `path` — which is what the API surfaces as `message`.
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['hourly_limits'],
      }),
    ]);
    expect(result.error?.issues.at(0)?.message).toContain('hourly_limits');
  });

  it('requires a delay once there is more than one recipient', () => {
    expect(
      issuePaths({ ...validBody, recipients: ['a@example.com', 'b@example.com'] }),
    ).toContain('delay_between_emails_ms');

    expect(
      scheduleEmailsBodySchema.safeParse({
        ...validBody,
        recipients: ['a@example.com', 'b@example.com'],
        delay_between_emails_ms: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects a start time with no timezone', () => {
    expect(issuePaths({ ...validBody, start_time: '2026-09-02T14:30:00' })).toContain(
      'start_time',
    );
  });

  it('accepts Z and numeric offsets, and parses both to the same instant', () => {
    const utc = scheduleEmailsBodySchema.parse({
      ...validBody,
      start_time: '2026-09-02T14:30:00Z',
    });
    const offset = scheduleEmailsBodySchema.parse({
      ...validBody,
      start_time: '2026-09-02T20:00:00+05:30',
    });

    expect(utc.start_time?.toISOString()).toBe('2026-09-02T14:30:00.000Z');
    expect(offset.start_time?.getTime()).toBe(utc.start_time?.getTime());
  });

  it('rejects empty and whitespace-only content', () => {
    expect(issuePaths({ ...validBody, subject: '   ' })).toContain('subject');
    expect(issuePaths({ ...validBody, body: '   ' })).toContain('body');
  });

  it('rejects a malformed recipient and names its position', () => {
    expect(
      issuePaths({
        ...validBody,
        recipients: ['fine@example.com', 'not-an-email'],
        delay_between_emails_ms: 0,
      }),
    ).toContain('recipients.1');
  });

  it('caps the recipient list', () => {
    const tooMany = Array.from(
      { length: MAX_RECIPIENTS + 1 },
      (_unused, index) => `r${String(index)}@example.com`,
    );

    expect(
      issuePaths({ ...validBody, recipients: tooMany, delay_between_emails_ms: 0 }),
    ).toContain('recipients');
  });

  it('rejects an empty recipient list', () => {
    expect(issuePaths({ ...validBody, recipients: [] })).toContain('recipients');
  });

  it('rejects a negative delay and a zero hourly limit', () => {
    expect(issuePaths({ ...validBody, delay_between_emails_ms: -1 })).toContain(
      'delay_between_emails_ms',
    );
    expect(issuePaths({ ...validBody, hourly_limit: 0 })).toContain('hourly_limit');
  });
});

describe('listQuerySchema', () => {
  it('defaults to the first page', () => {
    expect(listQuerySchema.parse({})).toEqual({ page: 1, per_page: 25 });
  });

  it('coerces query strings to numbers', () => {
    expect(listQuerySchema.parse({ page: '3', per_page: '50' })).toEqual({
      page: 3,
      per_page: 50,
    });
  });

  it('ignores unknown query parameters', () => {
    // Unlike the body: a stray ?utm_source= changes nothing about what is sent.
    expect(listQuerySchema.parse({ utm_source: 'newsletter' })).toEqual({
      page: 1,
      per_page: 25,
    });
  });

  it('rejects a page size above the cap, and non-numeric input', () => {
    expect(listQuerySchema.safeParse({ per_page: '1000' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ page: 'abc' }).success).toBe(false);
  });
});
