import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config/config.js';
import { getRedis } from '../db/redis.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors.js';
import { logger } from '../logger.js';

const STATE_PREFIX = 'reachinbox:slack-oauth:';
const STATE_TTL_SECONDS = 10 * 60;

function assertConfigured(): { clientId: string; clientSecret: string } {
  if (
    !config.slack.isConfigured ||
    config.slack.clientId === undefined ||
    config.slack.clientSecret === undefined
  ) {
    throw HttpError.serviceUnavailable('Slack OAuth is not configured');
  }
  return { clientId: config.slack.clientId, clientSecret: config.slack.clientSecret };
}

export async function createSlackAuthorizationUrl(senderReference: string): Promise<string> {
  const { clientId } = assertConfigured();
  const sender = await prisma.sender.findFirst({
    where: { OR: [{ id: senderReference }, { email: senderReference.toLowerCase() }] },
  });
  if (sender === null) throw HttpError.notFound('Sender not found');
  const state = randomBytes(32).toString('base64url');
  await getRedis().set(`${STATE_PREFIX}${state}`, sender.id, 'EX', STATE_TTL_SECONDS);
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', config.slack.redirectUri);
  // incoming-webhook gives Slack's selected channel URL; chat:write satisfies
  // the assignment and allows a later move away from webhook delivery.
  url.searchParams.set('scope', 'incoming-webhook,chat:write');
  url.searchParams.set('state', state);
  return url.toString();
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: { url?: string; channel_id?: string; channel?: string };
}

export async function finishSlackOAuth(code: string, state: string): Promise<void> {
  const { clientId, clientSecret } = assertConfigured();
  const redisKey = `${STATE_PREFIX}${state}`;
  const senderId = await getRedis().getdel(redisKey);
  if (senderId === null)
    throw HttpError.badRequest('Slack authorization has expired or was already used');
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: config.slack.redirectUri,
  });
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as SlackOAuthResponse;
  const hook = payload.incoming_webhook;
  if (!response.ok || !payload.ok || hook?.url === undefined || hook.channel_id === undefined) {
    throw HttpError.badRequest(
      `Slack OAuth failed: ${payload.error ?? 'missing incoming webhook grant'}`,
    );
  }
  // Raw SQL until Prisma client generation runs in the deployment pipeline.
  // The committed migration remains the schema authority; this explicit upsert
  // also means a reconnect replaces the prior workspace/channel cleanly.
  await prisma.$executeRaw`
    INSERT INTO slack_integrations (id, sender_id, team_id, team_name, channel_id, channel_name, webhook_url, updated_at)
    VALUES (${randomUUID()}::uuid, ${senderId}::uuid, ${payload.team?.id ?? 'unknown'}, ${payload.team?.name ?? null}, ${hook.channel_id}, ${hook.channel ?? null}, ${hook.url}, now())
    ON CONFLICT (sender_id) DO UPDATE SET team_id = EXCLUDED.team_id, team_name = EXCLUDED.team_name,
      channel_id = EXCLUDED.channel_id, channel_name = EXCLUDED.channel_name, webhook_url = EXCLUDED.webhook_url, updated_at = now()
  `;
}

export async function notifySlackRateLimit(senderId: string, retryAt: Date): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<Array<{ webhook_url: string }>>`
      SELECT webhook_url FROM slack_integrations WHERE sender_id = ${senderId}::uuid LIMIT 1
    `;
    const integration = rows[0];
    if (integration === undefined) return;
    const response = await fetch(integration.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `ReachInbox rate limit reached. Sending for this sender will resume after ${retryAt.toISOString()}.`,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Slack webhook failed (${String(response.status)})`);
  } catch (error) {
    logger.error({ err: error, senderId }, 'Could not send Slack rate-limit notification');
  }
}
