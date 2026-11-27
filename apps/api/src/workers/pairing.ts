import { Prisma, type PrismaClient } from '@prisma/client';
import type { WorkerPairRequest, WorkerPairResponse } from '@smb/shared';
import { writeAudit } from '../audit.js';
import { enqueueJob } from '../jobs/index.js';
import {
  generateDeviceToken,
  generatePairingCode,
  hashToken,
  normalisePairingCode,
} from './tokens.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;

export class PairingError extends Error {
  constructor(
    readonly status: 400 | 409 | 410,
    readonly code: 'pairing_code_invalid' | 'pairing_code_expired' | 'pairing_code_used',
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

export async function createPairingCode(
  db: PrismaClient,
  opts: { label?: string; createdBy: string; now?: Date },
): Promise<{ code: string; expiresAt: string }> {
  const at = opts.now ?? new Date();
  const expiresAt = new Date(at.getTime() + PAIRING_TTL_MS);
  const code = generatePairingCode();
  const codeHash = hashToken(normalisePairingCode(code));
  const label = opts.label?.trim() || null;

  const row = await db.$transaction(async (tx) => {
    const created = await tx.worker_pairing_codes.create({
      data: {
        code_hash: codeHash,
        label,
        created_by: opts.createdBy,
        created_at: at,
        expires_at: expiresAt,
      },
    });
    await writeAudit(tx, {
      actor: opts.createdBy,
      action: 'worker.pairing_code.create',
      targetType: 'worker_pairing_code',
      targetId: created.id,
      details: { label, expiresAt: expiresAt.toISOString() },
    });
    return created;
  });

  return { code, expiresAt: row.expires_at.toISOString() };
}

interface LockedCodeRow {
  id: string;
  label: string | null;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  worker_id: string | null;
}

/**
 * Exchanges a single-use pairing code for a new worker row, device token, and initial `worker_selftest` job.
 */
export async function pairWorker(
  db: PrismaClient,
  req: WorkerPairRequest,
  now: Date = new Date(),
): Promise<WorkerPairResponse> {
  const normalised = normalisePairingCode(req.pairingCode);
  if (!normalised) {
    throw new PairingError(400, 'pairing_code_invalid', 'Invalid pairing code');
  }
  const codeHash = hashToken(normalised);
  const deviceToken = generateDeviceToken();
  const tokenHash = hashToken(deviceToken);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedCodeRow[]>`
      select id, label, created_by, expires_at, used_at, worker_id
      from smb.worker_pairing_codes
      where code_hash = ${codeHash}
      for update`;
    const code = rows[0];
    if (!code) {
      throw new PairingError(400, 'pairing_code_invalid', 'Invalid pairing code');
    }
    if (code.used_at !== null || code.worker_id !== null) {
      throw new PairingError(409, 'pairing_code_used', 'Pairing code has already been used');
    }
    if (code.expires_at.getTime() <= now.getTime()) {
      throw new PairingError(410, 'pairing_code_expired', 'Pairing code has expired');
    }

    const worker = await tx.workers.create({
      data: {
        label: code.label,
        hostname: req.hostname,
        os: req.os,
        worker_version: req.workerVersion,
        gpu: req.gpu === null ? Prisma.DbNull : (req.gpu as Prisma.InputJsonValue),
        token_hash: tokenHash,
        paired_by: code.created_by,
        paired_at: now,
        last_seen_at: now,
      },
    });

    await tx.worker_pairing_codes.update({
      where: { id: code.id },
      data: { used_at: now, worker_id: worker.id },
    });

    await enqueueJob(tx, {
      kind: 'worker_selftest',
      scope: worker.id,
      idempotencyKey: `selftest:${worker.id}`,
      payload: { workerId: worker.id },
      maxAttempts: 2,
      runAfter: now,
    });

    await writeAudit(tx, {
      actor: `worker:${worker.id}`,
      action: 'worker.pair',
      targetType: 'worker',
      targetId: worker.id,
      details: {
        hostname: req.hostname,
        workerVersion: req.workerVersion,
        pairedBy: code.created_by,
        label: code.label,
      },
    });

    return { workerId: worker.id, deviceToken };
  });
}
