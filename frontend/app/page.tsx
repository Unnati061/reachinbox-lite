import { EmailDashboard } from '@/components/email-dashboard';
import { auth } from '@/auth';
import { api } from '@/lib/api';
import type { ScheduledEmailListItem } from '@/types';
import { redirect } from 'next/navigation';

/**
 * Placeholder home page.
 *
 * It exists to prove the scaffold end to end — Tailwind tokens, the UI
 * primitives and the typed API client all render and talk to the backend. The
 * campaign/schedule screens replace it in the next phase.
 */

// Rendered per request, never at build time: `next build` must not require a
// running API (or a database behind it) to succeed.
export const dynamic = 'force-dynamic';

async function loadEmails(): Promise<{
  scheduled: ScheduledEmailListItem[];
  sent: ScheduledEmailListItem[];
  error: string | null;
}> {
  try {
    const [scheduled, sent] = await Promise.all([api.scheduled(), api.sent()]);
    return { scheduled: scheduled.data, sent: sent.data, error: null };
  } catch (cause) {
    return {
      scheduled: [],
      sent: [],
      error: cause instanceof Error ? cause.message : 'Unknown error',
    };
  }
}

export default async function HomePage() {
  const session = await auth();
  if (session === null) redirect('/login');
  const snapshot = await loadEmails();
  return (
    <EmailDashboard
      {...snapshot}
      user={{
        name: session.user?.name ?? 'Google user',
        email: session.user?.email ?? '',
        image: session.user?.image ?? null,
      }}
    />
  );
}
