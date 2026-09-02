/**
 * Wire representations for the email endpoints.
 *
 * Serialising explicitly rather than returning Prisma rows keeps two things
 * from happening by accident: a column rename becoming a breaking API change,
 * and a column added for internal bookkeeping leaking to clients.
 *
 * Timestamps are ISO-8601 strings with a `Z` offset. `JSON.stringify` would
 * produce that anyway for a Date, but doing it here makes the contract explicit
 * and survives anyone later handing these objects to a different encoder.
 */

import type { EmailStatus, ScheduledEmail, Sender } from '../db/generated/client.js';

export interface SenderResource {
  id: string;
  email: string;
  display_name: string;
}

/**
 * One row in a list response.
 *
 * `body` is deliberately absent. A page of 100 emails each carrying a 100k
 * character body is a 10 MB response for a table view that renders neither.
 * A detail endpoint is the place for full content.
 */
export interface ScheduledEmailListItem {
  id: string;
  batch_id: string | null;
  sender_id: string;
  recipient_email: string;
  subject: string;
  scheduled_at: string;
  status: EmailStatus;
  bullmq_job_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

/** One planned send, as echoed back from POST /api/emails/schedule. */
export interface PlannedEmailResource {
  id: string;
  recipient_email: string;
  scheduled_at: string;
  status: EmailStatus;
}

export interface PaginationMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
  has_more: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ScheduleBatchResource {
  batch_id: string;
  sender: SenderResource;
  /** Rows written, after duplicate recipients were dropped. */
  scheduled_count: number;
  duplicates_removed: number;
  start_at: string;
  last_scheduled_at: string;
  /** What the planner actually used between consecutive sends. */
  effective_step_ms: number;
  /** What the caller asked for, so the two can be compared. */
  requested_delay_between_emails_ms: number;
  hourly_limit: number | null;
  /** True when `hourly_limit` forced a wider gap than `delay_between_emails_ms`. */
  widened_by_hourly_limit: boolean;
  emails: PlannedEmailResource[];
}

export function serializeSender(sender: Sender): SenderResource {
  return {
    id: sender.id,
    email: sender.email,
    display_name: sender.displayName,
  };
}

export function serializeScheduledEmail(row: ScheduledEmail): ScheduledEmailListItem {
  return {
    id: row.id,
    batch_id: row.batchId,
    sender_id: row.senderId,
    recipient_email: row.recipientEmail,
    subject: row.subject,
    scheduled_at: row.scheduledAt.toISOString(),
    status: row.status,
    bullmq_job_id: row.bullmqJobId,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    sent_at: row.sentAt === null ? null : row.sentAt.toISOString(),
  };
}

export function serializePlannedEmail(row: ScheduledEmail): PlannedEmailResource {
  return {
    id: row.id,
    recipient_email: row.recipientEmail,
    scheduled_at: row.scheduledAt.toISOString(),
    status: row.status,
  };
}

export function paginationMeta(page: number, perPage: number, total: number): PaginationMeta {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
    has_more: page * perPage < total,
  };
}
