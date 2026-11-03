import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ConfigError,
  ConfigOverride,
  PostTypeConfig,
  applyOverride,
  configHash,
  type ConfigSet,
} from '@smb/shared';

type Tx = Prisma.TransactionClient;

export interface SyncResult {
  postTypeId: string;
  action: 'created' | 'updated' | 'unchanged';
  version: number;
  /** True when a stored override no longer fits the new file config and was left out. */
  droppedOverride: boolean;
}

/** One writer at a time, so two API instances starting together cannot both create version N+1. */
async function lock(tx: Tx): Promise<void> {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('smb.post_configs'))`;
}

interface Activation {
  postTypeId: string;
  effective: PostTypeConfig;
  fileHash: string;
  override: Prisma.InputJsonValue | null;
  createdBy: string;
  auditAction: string;
  details: Record<string, unknown>;
}

/** Deactivates the current version and stores the next one as the active version. Never edits an existing row. */
async function activate(tx: Tx, a: Activation): Promise<number> {
  const latest = await tx.post_configs.aggregate({
    where: { post_type_id: a.postTypeId },
    _max: { version: true },
  });
  const version = (latest._max.version ?? 0) + 1;
  await tx.post_configs.updateMany({
    where: { post_type_id: a.postTypeId, is_active: true },
    data: { is_active: false },
  });
  const row = await tx.post_configs.create({
    data: {
      post_type_id: a.postTypeId,
      version,
      config_json: a.effective as unknown as Prisma.InputJsonValue,
      content_hash: configHash(a.effective),
      file_hash: a.fileHash,
      origin: a.override ? 'override' : 'file',
      override: a.override ?? undefined,
      is_active: true,
      created_by: a.createdBy,
    },
  });
  await tx.post_types.update({
    where: { id: a.postTypeId },
    data: { name: a.effective.name, enabled: a.effective.enabled },
  });
  await tx.audit_log.create({
    data: {
      actor: a.createdBy,
      action: a.auditAction,
      target_type: 'post_config',
      target_id: row.id,
      details: {
        postTypeId: a.postTypeId,
        version,
        fileHash: a.fileHash,
        ...a.details,
      } as Prisma.InputJsonValue,
    },
  });
  return version;
}

async function ensurePostType(tx: Tx, cfg: PostTypeConfig): Promise<void> {
  await tx.post_types.upsert({
    where: { id: cfg.id },
    create: { id: cfg.id, name: cfg.name, enabled: cfg.enabled },
    update: {},
  });
}

function fileConfig(set: ConfigSet, postTypeId: string): PostTypeConfig {
  const found = set.configs.find((c) => c.config.id === postTypeId);
  if (!found) throw new ConfigError([`no config file for post type ${postTypeId}`]);
  return found.config;
}

/**
 * Makes the database match the config files. A file whose content changed becomes a new version;
 * an unchanged file does nothing. A runtime override is carried over to the new version if it is still valid.
 */
export async function syncConfigs(
  db: PrismaClient,
  set: ConfigSet,
  actor = 'system',
): Promise<SyncResult[]> {
  return db.$transaction(async (tx) => {
    await lock(tx);
    const results: SyncResult[] = [];
    for (const { config: cfg } of set.configs) {
      await ensurePostType(tx, cfg);
      const fileHash = configHash(cfg);
      const active = await tx.post_configs.findFirst({
        where: { post_type_id: cfg.id, is_active: true },
      });

      if (active?.file_hash === fileHash) {
        results.push({
          postTypeId: cfg.id,
          action: 'unchanged',
          version: active.version,
          droppedOverride: false,
        });
        continue;
      }

      let effective = cfg;
      let override: Prisma.InputJsonValue | null = null;
      let droppedOverride = false;
      if (active?.override) {
        try {
          effective = applyOverride(cfg, active.override);
          override = active.override as Prisma.InputJsonValue;
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          droppedOverride = true;
        }
      }
      const version = await activate(tx, {
        postTypeId: cfg.id,
        effective,
        fileHash,
        override,
        createdBy: override ? (active?.created_by ?? actor) : actor,
        auditAction: 'config.sync',
        details: { droppedOverride },
      });
      results.push({
        postTypeId: cfg.id,
        action: active ? 'updated' : 'created',
        version,
        droppedOverride,
      });
    }
    return results;
  });
}

/** Replaces the runtime override for a post type (an override is a single patch, not a stack). */
export async function setOverride(
  db: PrismaClient,
  set: ConfigSet,
  postTypeId: string,
  patch: unknown,
  actor: string,
): Promise<{ version: number }> {
  const cfg = fileConfig(set, postTypeId);
  const effective = applyOverride(cfg, patch); // throws ConfigError if the patch is not allowed
  const parsed = ConfigOverride.parse(patch);
  return db.$transaction(async (tx) => {
    await lock(tx);
    await ensurePostType(tx, cfg);
    const version = await activate(tx, {
      postTypeId,
      effective,
      fileHash: configHash(cfg),
      override: parsed as Prisma.InputJsonValue,
      createdBy: actor,
      auditAction: 'config.override',
      details: { override: parsed },
    });
    return { version };
  });
}

/** Goes back to the plain file config. */
export async function clearOverride(
  db: PrismaClient,
  set: ConfigSet,
  postTypeId: string,
  actor: string,
): Promise<{ version: number }> {
  const cfg = fileConfig(set, postTypeId);
  return db.$transaction(async (tx) => {
    await lock(tx);
    await ensurePostType(tx, cfg);
    const version = await activate(tx, {
      postTypeId,
      effective: cfg,
      fileHash: configHash(cfg),
      override: null,
      createdBy: actor,
      auditAction: 'config.override_cleared',
      details: {},
    });
    return { version };
  });
}

/** The effective config currently in force for a post type, re-validated on the way out. */
export async function getActiveConfig(db: PrismaClient, postTypeId: string) {
  const row = await db.post_configs.findFirst({
    where: { post_type_id: postTypeId, is_active: true },
  });
  if (!row) throw new ConfigError([`no active config for post type ${postTypeId}`]);
  return {
    id: row.id,
    version: row.version,
    origin: row.origin,
    config: PostTypeConfig.parse(row.config_json),
  };
}
