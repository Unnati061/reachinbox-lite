import { Router } from 'express';
import {
  listQuerySchema,
  scheduleEmailsBodySchema,
} from '../schemas/email.schemas.js';
import {
  listScheduledEmails,
  listSentEmails,
  scheduleEmails,
} from '../services/email.service.js';
import {
  paginationMeta,
  serializePlannedEmail,
  serializeScheduledEmail,
  serializeSender,
} from './email.serializers.js';
import type {
  PaginatedResponse,
  ScheduleBatchResource,
  ScheduledEmailListItem,
} from './email.serializers.js';

export const emailRouter = Router();

/**
 * POST /api/emails/schedule
 *
 * No try/catch anywhere below: Express 5 forwards a rejected promise to the
 * error middleware, which already knows how to render `ZodError` as a 400 with
 * per-field detail and `HttpError` as its own status. A handler that caught and
 * re-shaped errors here would be a second, divergent copy of that logic.
 *
 * 201 with the batch resource. The response echoes both the requested delay and
 * the effective step, because those differ whenever `hourly_limit` is the
 * tighter constraint and a caller should not have to re-derive that.
 */
emailRouter.post('/schedule', async (req, res) => {
  const body = scheduleEmailsBodySchema.parse(req.body);
  const result = await scheduleEmails(body);

  const payload: ScheduleBatchResource = {
    batch_id: result.batchId,
    sender: serializeSender(result.sender),
    scheduled_count: result.emails.length,
    duplicates_removed: result.duplicatesRemoved,
    start_at: result.startAt.toISOString(),
    last_scheduled_at: result.lastScheduledAt.toISOString(),
    effective_step_ms: result.effectiveStepMs,
    requested_delay_between_emails_ms: result.requestedDelayMs,
    hourly_limit: result.hourlyLimit,
    widened_by_hourly_limit: result.widenedByHourlyLimit,
    emails: result.emails.map(serializePlannedEmail),
  };

  res.status(201).json(payload);
});

/** GET /api/emails/scheduled — pending and processing, soonest first. */
emailRouter.get('/scheduled', async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const { rows, total } = await listScheduledEmails(query);

  const payload: PaginatedResponse<ScheduledEmailListItem> = {
    data: rows.map(serializeScheduledEmail),
    meta: paginationMeta(query.page, query.per_page, total),
  };

  res.json(payload);
});

/** GET /api/emails/sent — sent and failed, most recent first. */
emailRouter.get('/sent', async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const { rows, total } = await listSentEmails(query);

  const payload: PaginatedResponse<ScheduledEmailListItem> = {
    data: rows.map(serializeScheduledEmail),
    meta: paginationMeta(query.page, query.per_page, total),
  };

  res.json(payload);
});
