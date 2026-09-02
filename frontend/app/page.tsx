import { StatusPanel } from '@/components/status-panel';
import type { HealthSnapshot } from '@/components/status-panel';
import { api } from '@/lib/api';

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

async function loadSnapshot(): Promise<HealthSnapshot> {
  try {
    const [health, readiness] = await Promise.all([api.health(), api.readiness()]);
    return { health, readiness, error: null };
  } catch (cause) {
    // A down API is an expected state here, not a crash — render the reason.
    return {
      health: null,
      readiness: null,
      error: cause instanceof Error ? cause.message : 'Unknown error',
    };
  }
}

export default async function HomePage() {
  const snapshot = await loadSnapshot();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">
          Scaffold · phase 1
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">ReachInbox-lite</h1>
        <p className="text-ink-muted">
          Schedule email campaigns and watch them send. Nothing is wired to a real mailbox yet —
          this page only checks that the app can reach the API.
        </p>
      </header>

      <StatusPanel snapshot={snapshot} />

      <footer className="mt-auto border-t border-line pt-6 text-sm text-ink-muted">
        See <code className="font-mono text-ink">DECISIONS.md</code> for why the stack looks the way
        it does, and <code className="font-mono text-ink">README.md</code> to get the datastores up.
      </footer>
    </main>
  );
}
