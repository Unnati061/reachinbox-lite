import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

/**
 * Auth.js reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and AUTH_SECRET from the
 * server environment. None is prefixed NEXT_PUBLIC, so neither the OAuth
 * secret nor the session signing key reaches browser JavaScript.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  pages: { signIn: '/login' },
  callbacks: {
    // This is an assignment dashboard, not a multi-tenant public product. Any
    // Google account that completes the configured OAuth consent flow may use
    // the local dashboard. An allow-list belongs in the future user/tenant DB.
    authorized: ({ auth }) => auth !== null,
  },
});
