import type { Prisma, PrismaClient } from '@prisma/client';
import type { PublishMode } from '@smb/shared';
import { writeAudit } from '../audit.js';
import type { Env } from '../env.js';

const RANK: Record<PublishMode, number> = {
  dry_run: 0,
  sandbox: 1,
  live: 2,
};

export function publishRank(mode: PublishMode): number {
  return RANK[mode];
}

export type PublishGateEnv = Pick<
  Env,
  'SMB_PUBLISH_MODE' | 'SMB_ALLOW_LIVE_PUBLISH' | 'SMB_DEPLOYMENT'
>;

export interface LiveGateStatus {
  ceilingLive: boolean;
  allowLive: boolean;
  production: boolean;
}

export interface PublishModeState {
  setting: PublishMode;
  ceiling: PublishMode;
  effective: PublishMode;
  liveGates: LiveGateStatus;
  updatedBy: string;
  updatedAt: string;
  reason: string;
}

export class PublishModeError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PublishModeError';
  }
}

export function liveGatesOf(env: PublishGateEnv): LiveGateStatus {
  return {
    ceilingLive: env.SMB_PUBLISH_MODE === 'live',
    allowLive: env.SMB_ALLOW_LIVE_PUBLISH,
    production: env.SMB_DEPLOYMENT === 'production',
  };
}

/**
 * Resolves the effective publish mode from the stored admin setting and environment gates:
 * - Capped by the environment ceiling (`SMB_PUBLISH_MODE`)
 * - `live` requires ceiling = `live`, `SMB_ALLOW_LIVE_PUBLISH=true`, and `SMB_DEPLOYMENT=production`
 */
export function resolveEffectivePublishMode(
  setting: PublishMode,
  env: PublishGateEnv,
): PublishMode {
  const ceiling = env.SMB_PUBLISH_MODE;
  const capped = publishRank(setting) <= publishRank(ceiling) ? setting : ceiling;
  if (capped === 'live') {
    const gates = liveGatesOf(env);
    if (!gates.ceilingLive || !gates.allowLive || !gates.production) {
      return publishRank(ceiling) >= RANK.sandbox ? 'sandbox' : ceiling;
    }
  }
  return capped;
}

export function isModeAllowed(effective: PublishMode, mode: PublishMode): boolean {
  return publishRank(mode) <= publishRank(effective);
}

/** Reads the single-row `smb.publish_settings` without caching and returns the effective publish mode. */
export async function effectivePublishMode(
  db: PrismaClient | Prisma.TransactionClient,
  env: PublishGateEnv,
): Promise<PublishMode> {
  const row = await db.publish_settings.findUnique({ where: { id: true } });
  const setting = (row?.mode ?? 'dry_run') as PublishMode;
  return resolveEffectivePublishMode(setting, env);
}

/** Reads the full publish-mode state (setting, ceiling, effective mode, gates, metadata). */
export async function getPublishModeState(
  db: PrismaClient,
  env: PublishGateEnv,
): Promise<PublishModeState> {
  const row = await db.publish_settings.findUnique({ where: { id: true } });
  const setting = (row?.mode ?? 'dry_run') as PublishMode;
  return {
    setting,
    ceiling: env.SMB_PUBLISH_MODE,
    effective: resolveEffectivePublishMode(setting, env),
    liveGates: liveGatesOf(env),
    updatedBy: row?.updated_by ?? 'system',
    updatedAt: (row?.updated_at ?? new Date(0)).toISOString(),
    reason: row?.reason ?? 'initial',
  };
}

/** Updates the stored publish-mode setting after enforcing confirmation, ceiling, and live gates. */
export async function setPublishMode(
  db: PrismaClient,
  env: PublishGateEnv,
  actor: string,
  input: { mode: PublishMode; reason: string; confirm?: string },
): Promise<PublishModeState> {
  if (input.mode === 'live' && input.confirm !== 'PUBLISH LIVE') {
    throw new PublishModeError(
      400,
      'confirmation_required',
      'Switching to live mode requires confirm: "PUBLISH LIVE"',
    );
  }
  if (publishRank(input.mode) > publishRank(env.SMB_PUBLISH_MODE)) {
    throw new PublishModeError(
      409,
      'mode_above_ceiling',
      `Requested mode '${input.mode}' exceeds environment ceiling '${env.SMB_PUBLISH_MODE}'`,
      { requested: input.mode, ceiling: env.SMB_PUBLISH_MODE },
    );
  }
  if (input.mode === 'live') {
    const gates = liveGatesOf(env);
    const failed = Object.entries(gates)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (failed.length > 0) {
      throw new PublishModeError(
        409,
        'live_not_allowed',
        `Live publishing is blocked by environment gates: ${failed.join(', ')}`,
        { gates, failed },
      );
    }
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.publish_settings.findUnique({ where: { id: true } });
    const from = (existing?.mode ?? 'dry_run') as PublishMode;
    const now = new Date();
    const row = await tx.publish_settings.upsert({
      where: { id: true },
      create: {
        id: true,
        mode: input.mode,
        updated_by: actor,
        reason: input.reason,
        updated_at: now,
      },
      update: {
        mode: input.mode,
        updated_by: actor,
        reason: input.reason,
        updated_at: now,
      },
    });
    const effective = resolveEffectivePublishMode(input.mode, env);
    await writeAudit(tx, {
      actor,
      action: 'publish_mode.change',
      targetType: 'publish_settings',
      targetId: 'default',
      details: {
        from,
        to: input.mode,
        reason: input.reason,
        ceiling: env.SMB_PUBLISH_MODE,
        effective,
      },
    });
    return {
      setting: row.mode as PublishMode,
      ceiling: env.SMB_PUBLISH_MODE,
      effective,
      liveGates: liveGatesOf(env),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at.toISOString(),
      reason: row.reason,
    };
  });
}
