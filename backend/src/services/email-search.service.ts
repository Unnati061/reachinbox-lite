/**
 * Elasticsearch projection for email discovery.
 *
 * Postgres remains the delivery source of truth. Search is deliberately a
 * rebuildable read model: an indexing outage is logged but never rolls back a
 * committed schedule or a completed SMTP delivery.
 */
import type { EmailStatus, ScheduledEmail, Sender } from '../db/generated/client.js';
import { config } from '../config/config.js';
import { logger } from '../logger.js';

const INDEX = 'reachinbox-emails';
let ensureIndexPromise: Promise<void> | undefined;

export interface SearchEmailHit {
  readonly id: string;
  readonly recipient_email: string;
  readonly sender_email: string;
  readonly subject: string;
  readonly status: EmailStatus;
  readonly scheduled_at: string;
  readonly sent_at: string | null;
  readonly error: string | null;
}

function baseUrl(): string | undefined {
  return config.search.elasticsearchUrl?.replace(/\/+$/, '');
}

async function elastic(path: string, init: RequestInit): Promise<Response> {
  const url = baseUrl();
  if (url === undefined)
    throw new Error('Elasticsearch is not configured: ELASTICSEARCH_URL is unset');
  // Node's fetch correctly refuses URLs with embedded credentials. Bonsai and
  // other hosted providers often give that convenient URL form, so translate
  // it to the HTTP Basic header before constructing the request. The error
  // paths below intentionally mention only a path/status, never the endpoint.
  const endpoint = new URL(`${url}${path}`);
  const user = endpoint.username;
  const password = endpoint.password;
  endpoint.username = '';
  endpoint.password = '';
  const authorization =
    user === ''
      ? {}
      : { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authorization,
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(
      `Elasticsearch ${init.method ?? 'GET'} ${path} failed (${String(response.status)})`,
    );
  return response;
}

/** Create an explicit mapping once; an existing index returns 400 and is fine. */
async function ensureIndex(): Promise<void> {
  try {
    await elastic(`/${INDEX}`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: {
          properties: {
            id: { type: 'keyword' },
            recipient_email: { type: 'keyword' },
            sender_email: { type: 'keyword' },
            subject: { type: 'text' },
            status: { type: 'keyword' },
            scheduled_at: { type: 'date' },
            sent_at: { type: 'date' },
            error: { type: 'text' },
          },
        },
      }),
    });
  } catch (error) {
    // Concurrent API instances can race on initial creation. Elasticsearch and
    // OpenSearch respond with 400 resource_already_exists_exception in that case.
    if (!(error instanceof Error && error.message.includes('failed (400)'))) throw error;
  }
}

async function ensureEmailIndex(): Promise<void> {
  ensureIndexPromise ??= ensureIndex().catch((error: unknown) => {
    ensureIndexPromise = undefined;
    throw error;
  });
  await ensureIndexPromise;
}

function documentFor(row: ScheduledEmail, sender: Sender): SearchEmailHit {
  return {
    id: row.id,
    recipient_email: row.recipientEmail,
    sender_email: sender.email,
    subject: row.subject,
    status: row.status,
    scheduled_at: row.scheduledAt.toISOString(),
    sent_at: row.sentAt?.toISOString() ?? null,
    error: row.error,
  };
}

/** Upsert is idempotent: replays and retries replace the same document id. */
export async function indexEmail(row: ScheduledEmail, sender: Sender): Promise<void> {
  if (baseUrl() === undefined) return;
  try {
    await ensureEmailIndex();
    await elastic(`/${INDEX}/_doc/${encodeURIComponent(row.id)}`, {
      method: 'PUT',
      body: JSON.stringify(documentFor(row, sender)),
    });
  } catch (error) {
    logger.error(
      { err: error, emailId: row.id },
      'Could not index email; delivery state remains in Postgres',
    );
  }
}

export async function searchEmails(query: string): Promise<SearchEmailHit[]> {
  await ensureEmailIndex();
  const response = await elastic(`/${INDEX}/_search`, {
    method: 'POST',
    body: JSON.stringify({
      size: 50,
      sort: [{ scheduled_at: { order: 'desc' } }],
      query: {
        multi_match: {
          query,
          fields: ['recipient_email^3', 'sender_email^2', 'subject', 'status'],
        },
      },
    }),
  });
  const payload: unknown = await response.json();
  const hits = (payload as { hits?: { hits?: Array<{ _source?: unknown }> } }).hits?.hits ?? [];
  return hits.flatMap((hit) => (isSearchHit(hit._source) ? [hit._source] : []));
}

function isSearchHit(value: unknown): value is SearchEmailHit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'recipient_email' in value &&
    'subject' in value
  );
}
