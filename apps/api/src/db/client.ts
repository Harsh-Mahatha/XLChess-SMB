import type { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * Lazy Prisma client. Models appear after the migrations in module 1.2 and `npm run db:pull`.
 * Claim/lease queries use $queryRaw with FOR UPDATE SKIP LOCKED.
 */
export async function getDb(): Promise<PrismaClient> {
  if (!client) {
    const { PrismaClient } = await import('@prisma/client');
    client = new PrismaClient();
  }
  return client;
}
