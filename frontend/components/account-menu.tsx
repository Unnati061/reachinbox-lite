'use client';

import { signOut } from 'next-auth/react';

import { Button } from '@/components/ui';

export function AccountMenu({
  user,
}: {
  user: { name: string; email: string; image: string | null };
}) {
  return (
    <div className="flex items-center gap-3">
      {user.image === null ? (
        <span
          className="grid size-9 place-items-center rounded-full bg-accent/15 text-sm font-bold text-accent"
          aria-hidden="true"
        >
          {user.name.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        // Google controls the URL and image; an ordinary img avoids a remote
        // image allow-list solely for an avatar.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.image} alt="" className="size-9 rounded-full" referrerPolicy="no-referrer" />
      )}
      <div className="hidden text-right sm:block">
        <p className="max-w-48 truncate text-sm font-medium">{user.name}</p>
        <p className="max-w-48 truncate text-xs text-ink-muted">{user.email}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void signOut({ callbackUrl: '/login' })}>
        Logout
      </Button>
    </div>
  );
}
