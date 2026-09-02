import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/config.js';
import { PrismaClient } from './generated/client.js';

/**
 * Prisma client singleton.
 *
 * Prisma 7 talks to Postgres through a driver adapter (node-postgres) rather
 * than a bundled Rust engine, so the pool is constructed explicitly here.
 * Nothing connects until the first query — importing this module is cheap and
 * safe even with the database down.
 */
const adapter = new PrismaPg({ connectionString: config.db.url });

export const prisma = new PrismaClient({
  adapter,
  log: config.isDevelopment ? ['warn', 'error'] : ['error'],
});

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
