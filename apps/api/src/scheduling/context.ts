import type { Prisma, PrismaClient } from '@prisma/client';
import type { PostTypeConfig } from '@smb/shared';
import type { OpportunityContext } from './types.js';

export type ContextResult =
  | { kind: 'ready'; context: OpportunityContext }
  | { kind: 'hold'; code: string; reason: string };

export interface ContextResolver {
  resolve(input: {
    postTypeId: string;
    config: PostTypeConfig;
    trigger: 'schedule' | 'manual';
    now: Date;
    db: PrismaClient | Prisma.TransactionClient;
  }): Promise<ContextResult>;
}

export const defaultResolver: ContextResolver = {
  async resolve(input) {
    const slug = input.postTypeId.replace(/\./g, '-');
    return {
      kind: 'ready',
      context: {
        phase: null,
        subject: { eventRefs: {} },
        eventKey: `pt${slug}`,
      },
    };
  },
};

export class ContextResolvers {
  private readonly map = new Map<string, ContextResolver>();

  register(postTypeId: string, r: ContextResolver): void {
    this.map.set(postTypeId, r);
  }

  for(postTypeId: string): ContextResolver {
    return this.map.get(postTypeId) ?? defaultResolver;
  }
}
