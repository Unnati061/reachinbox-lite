// Prisma 7 no longer reads `package.json#prisma` and no longer auto-loads .env,
// so CLI configuration lives here and dotenv is imported explicitly.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Deliberately NOT prisma/config's env() helper: that throws on a missing
    // variable, which would break `prisma generate` on a fresh clone or in CI
    // where no database exists yet. Commands that actually need a connection
    // (migrate, studio) fail with Prisma's own error instead.
    url: process.env.DATABASE_URL ?? '',
  },
});
