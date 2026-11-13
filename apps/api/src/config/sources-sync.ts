import type { Prisma, PrismaClient } from '@prisma/client';
import { configHash, type SourcesRegistry } from '@smb/shared';

export interface SourceSyncResult {
  sourceId: string;
  action: 'created' | 'updated' | 'unchanged';
}

/**
 * Makes smb.data_sources match config/sources.json (names, URLs, enabled flag, and the policy,
 * reliability, capabilities and limits stored under `config`). Writes an audit entry per change.
 * Source rows are never deleted: records may still reference them.
 */
export async function syncSources(
  db: PrismaClient,
  registry: SourcesRegistry,
  actor = 'system',
): Promise<SourceSyncResult[]> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('smb.data_sources'))`;
    const results: SourceSyncResult[] = [];
    for (const s of registry.sources) {
      const wanted = {
        kind: s.kind,
        name: s.name,
        base_url: s.access.baseUrl ?? null,
        terms_url: s.access.termsUrl ?? null,
        enabled: s.enabled,
        config:
          s.kind === 'data'
            ? {
                reliability: s.reliability,
                access: s.access,
                policy: s.policy,
                capabilities: s.capabilities,
                limits: s.limits,
              }
            : { access: s.access, policy: s.policy, roles: s.roles, limits: s.limits },
      };

      const existing = await tx.data_sources.findUnique({ where: { id: s.id } });
      const unchanged =
        existing &&
        existing.kind === wanted.kind &&
        existing.name === wanted.name &&
        existing.base_url === wanted.base_url &&
        existing.terms_url === wanted.terms_url &&
        existing.enabled === wanted.enabled &&
        configHash(existing.config) === configHash(wanted.config);
      if (unchanged) {
        results.push({ sourceId: s.id, action: 'unchanged' });
        continue;
      }
      const data = { ...wanted, config: wanted.config as Prisma.InputJsonValue };
      await tx.data_sources.upsert({
        where: { id: s.id },
        create: { id: s.id, ...data },
        update: data,
      });
      await tx.audit_log.create({
        data: {
          actor,
          action: existing ? 'source.update' : 'source.create',
          target_type: 'data_source',
          target_id: s.id,
          details: {
            sourceId: s.id,
            enabled: wanted.enabled,
            configHash: configHash(wanted.config),
          } as Prisma.InputJsonValue,
        },
      });
      results.push({ sourceId: s.id, action: existing ? 'updated' : 'created' });
    }
    return results;
  });
}
