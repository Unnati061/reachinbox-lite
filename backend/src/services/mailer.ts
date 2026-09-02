/**
 * SMTP transport for the worker.
 *
 * One pooled nodemailer transport, built on first use rather than at import —
 * the worker entry point imports this module before it knows whether a job will
 * ever run, and importing must not open a socket. Everything nodemailer-specific
 * stays behind this boundary: callers get a normalised {@link SendOutcome} and
 * never see nodemailer's types, so a later provider or library swap is a
 * one-file change.
 */
import { createTransport, getTestMessageUrl } from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { config } from '../config/config.js';
import { logger } from '../logger.js';

/** No point holding more sockets open than the worker has concurrent senders. */
const MAX_POOLED_CONNECTIONS = 5;

/** Default submission port when SMTP_PORT is unset. */
const DEFAULT_SMTP_PORT = 587;

function buildTransport() {
  const { host, port, user, password } = config.mail;
  if (host === undefined) {
    // Reached only once a job is actually processing, so this is a run-time
    // misconfiguration, not an import-time one — surfaced as a send failure.
    throw new Error('SMTP is not configured: SMTP_HOST is unset');
  }
  const resolvedPort = port ?? DEFAULT_SMTP_PORT;
  return createTransport({
    host,
    port: resolvedPort,
    // 465 is implicit TLS; 587/25 start plaintext and upgrade with STARTTLS.
    // Ethereal (and most providers) use 587.
    secure: resolvedPort === 465,
    pool: true,
    maxConnections: MAX_POOLED_CONNECTIONS,
    // Only send AUTH when a user is set. exactOptionalPropertyTypes forbids
    // `auth: undefined`, so the key is added conditionally rather than nulled.
    ...(user === undefined ? {} : { auth: { user, pass: password ?? '' } }),
  });
}

type AppTransport = ReturnType<typeof buildTransport>;

let transporter: AppTransport | undefined;

function getMailer(): AppTransport {
  transporter ??= buildTransport();
  return transporter;
}

/** What a caller needs from a send, with nodemailer's types kept out of sight. */
export interface SendOutcome {
  /** How many recipients the server accepted. Zero means nothing was delivered. */
  readonly acceptedCount: number;
  /** Recipients the server refused, as plain addresses. */
  readonly rejected: readonly string[];
  readonly messageId: string | undefined;
  /** Ethereal preview link when the transport is Ethereal, otherwise false. */
  readonly previewUrl: string | false;
}

function addressText(value: string | { address?: string }): string {
  return typeof value === 'string' ? value : (value.address ?? JSON.stringify(value));
}

/** Send one message. Rejects on transport/protocol errors (the worker classifies them). */
export async function sendEmail(message: SendMailOptions): Promise<SendOutcome> {
  const info = await getMailer().sendMail(message);
  return {
    acceptedCount: info.accepted.length,
    rejected: info.rejected.map(addressText),
    messageId: info.messageId,
    // The pooled transport's info type omits `pending` that getTestMessageUrl's
    // parameter declares; the shape is otherwise identical, so route through
    // unknown (nodemailer only reads it to detect Ethereal and build the URL).
    previewUrl: getTestMessageUrl(info as unknown as Parameters<typeof getTestMessageUrl>[0]),
  };
}

/**
 * Open a connection and run the SMTP handshake so misconfiguration surfaces at
 * worker startup instead of on the first real send.
 */
export async function verifyMailer(): Promise<void> {
  await getMailer().verify();
}

/** Close pooled connections during shutdown. A no-op when nothing was opened. */
export function closeMailer(): void {
  if (transporter === undefined) return;
  transporter.close();
  transporter = undefined;
  logger.debug('SMTP transport closed');
}
