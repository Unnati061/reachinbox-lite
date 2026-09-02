import { redirect } from 'next/navigation';

import { auth, signIn } from '@/auth';
import { Button } from '@/components/ui';

export default async function LoginPage() {
  const session = await auth();
  if (session !== null) redirect('/');

  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <section className="w-full max-w-md rounded-xl border border-line bg-surface p-7 shadow-sm">
        <p className="text-xs font-bold tracking-widest text-accent uppercase">ReachInbox</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Sign in with Google to open the email scheduling dashboard.
        </p>
        <form
          className="mt-7"
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <Button type="submit" fullWidth>
            Continue with Google
          </Button>
        </form>
      </section>
    </main>
  );
}
