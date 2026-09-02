#!/usr/bin/env node
/**
 * Register a From identity.
 *
 *   npm run sender:create --workspace backend -- --email you@ethereal.email --name "Ada Lovelace"
 *
 * Exists because `POST /api/emails/schedule` resolves the sender and refuses to
 * invent one, and this phase deliberately ships no sender-management endpoint —
 * an unauthenticated API that can mint send-as identities is not something to
 * expose even locally.
 *
 * No SMTP secret is passed or stored. `--credential-ref` names a credential set
 * that lives in the environment (`SMTP_*`); see DECISIONS.md.
 */

import { parseArgs } from 'node:util';
import { config } from '../config/config.js';
import { disconnectDatabase, prisma } from '../db/client.js';
import { logger } from '../logger.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'credential-ref': { type: 'string', default: 'default' },
    },
  });

  // Falls back to MAIL_FROM so a configured .env needs no arguments at all.
  const email = (values.email ?? config.mail.from ?? '').trim().toLowerCase();

  if (email === '') {
    logger.error(
      'No sender address. Pass --email, or set MAIL_FROM in backend/.env and re-run.',
    );
    return 1;
  }

  if (!email.includes('@')) {
    logger.error({ email }, 'Not an email address');
    return 1;
  }

  // The part before the @ is a poor display name, but it is a truthful one —
  // better than a placeholder that ends up in a real recipient's inbox.
  const displayName = values.name?.trim() ?? email.slice(0, email.indexOf('@'));

  const sender = await prisma.sender.upsert({
    where: { email },
    // Re-running with a new display name should update it, not fail.
    update: { displayName, smtpCredentialRef: values['credential-ref'], isActive: true },
    create: { email, displayName, smtpCredentialRef: values['credential-ref'] },
  });

  logger.info(
    {
      id: sender.id,
      email: sender.email,
      displayName: sender.displayName,
      smtpCredentialRef: sender.smtpCredentialRef,
    },
    'Sender ready — use its id or email as the `sender` field when scheduling',
  );

  return 0;
}

main()
  .then(async (code) => {
    await disconnectDatabase();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'Could not create the sender');
    await disconnectDatabase();
    process.exitCode = 1;
  });
