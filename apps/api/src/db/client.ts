import type { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * Lazy Prisma client. Models are introspected from the `smb` schema (`npm run db:pull` after each migration).
 * Claim/lease queries use $queryRaw with FOR UPDATE SKIP LOCKED.
 */
export async function getDb(): Promise<PrismaClient> {
  if (!client) {
    const { PrismaClient } = await import('@prisma/client');
    client = new PrismaClient();
  }
  return client;
}
