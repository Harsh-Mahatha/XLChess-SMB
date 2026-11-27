import { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import { GPU_JOB_KINDS } from '@smb/shared';
import { claimJob, enqueueJob } from '../../../apps/api/src/jobs/index.js';
import {
  PairingError,
  createPairingCode,
  hashToken,
  pairWorker,
  revokeWorker,
} from '../../../apps/api/src/workers/index.js';
import { freshDb } from './harness.js';

let pgc: pg.Client;
let prisma: PrismaClient;

beforeAll(async () => {
  pgc = await freshDb();
  prisma = new PrismaClient({ datasourceUrl: `${inject('dbUrl')}?schema=smb` });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pgc.end();
});

beforeEach(async () => {
  await pgc.query(
    "update smb.jobs set status = 'cancelled', lease_id = null, leased_by = null, lease_expires_at = null where status in ('queued', 'leased')",
  );
});

describe('workers services', () => {
  it('pairs a worker, marks code used, stores hashed token and queues one worker_selftest', async () => {
    const now = new Date('2026-11-26T10:00:00Z');
    const created = await createPairingCode(prisma, {
      label: 'RTX 4070',
      createdBy: 'admin-1',
      now,
    });
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const paired = await pairWorker(
      prisma,
      {
        pairingCode: created.code.toLowerCase().replace('-', ' '),
        workerVersion: '0.1.0',
        hostname: 'home-pc',
        os: 'Windows 11 Pro',
        gpu: { name: 'NVIDIA GeForce RTX 4070', totalMiB: 12282 },
      },
      new Date(now.getTime() + 60_000),
    );
    expect(paired.deviceToken).toMatch(/^smbw_/);

    const row = await prisma.workers.findUniqueOrThrow({ where: { id: paired.workerId } });
    expect(row.token_hash).toBe(hashToken(paired.deviceToken));
    expect(row.label).toBe('RTX 4070');

    const selfTest = await prisma.jobs.findUnique({
      where: { idempotency_key: `selftest:${paired.workerId}` },
    });
    expect(selfTest).toMatchObject({ kind: 'worker_selftest', status: 'queued', max_attempts: 2 });
  });

  it('rejects unknown, expired, and already-used pairing codes with the exact error codes', async () => {
    await expect(
      pairWorker(prisma, {
        pairingCode: 'ZZZZ-ZZZZ',
        workerVersion: '0.1.0',
        hostname: 'pc',
        os: 'Windows 11',
        gpu: null,
      }),
    ).rejects.toMatchObject({ code: 'pairing_code_invalid', status: 400 });

    const issuedAt = new Date('2026-11-26T10:00:00Z');
    const exp = await createPairingCode(prisma, { createdBy: 'admin-1', now: issuedAt });
    await expect(
      pairWorker(
        prisma,
        {
          pairingCode: exp.code,
          workerVersion: '0.1.0',
          hostname: 'pc',
          os: 'Windows 11',
          gpu: null,
        },
        new Date(issuedAt.getTime() + 11 * 60_000),
      ),
    ).rejects.toMatchObject({ code: 'pairing_code_expired', status: 410 });

    const used = await createPairingCode(prisma, { createdBy: 'admin-1', now: issuedAt });
    await pairWorker(
      prisma,
      {
        pairingCode: used.code,
        workerVersion: '0.1.0',
        hostname: 'pc-1',
        os: 'Windows 11',
        gpu: null,
      },
      new Date(issuedAt.getTime() + 60_000),
    );
    await expect(
      pairWorker(
        prisma,
        {
          pairingCode: used.code,
          workerVersion: '0.1.0',
          hostname: 'pc-2',
          os: 'Windows 11',
          gpu: null,
        },
        new Date(issuedAt.getTime() + 120_000),
      ),
    ).rejects.toMatchObject({ code: 'pairing_code_used', status: 409 });
  });

  it('allows only one of two concurrent pair attempts with the same code', async () => {
    const now = new Date('2026-11-26T11:00:00Z');
    const code = await createPairingCode(prisma, { createdBy: 'admin-1', now });
    const req = (host: string) =>
      pairWorker(
        prisma,
        {
          pairingCode: code.code,
          workerVersion: '0.1.0',
          hostname: host,
          os: 'Windows 11',
          gpu: null,
        },
        new Date(now.getTime() + 1000),
      );

    const results = await Promise.allSettled([req('pc-a'), req('pc-b')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const err = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(err[0]!.reason).toBeInstanceOf(PairingError);
    expect((err[0]!.reason as PairingError).code).toBe('pairing_code_used');
  });

  it('scopes worker_selftest to its target worker via forWorker', async () => {
    const now = new Date();
    const c1 = await createPairingCode(prisma, { createdBy: 'admin-1', now });
    const c2 = await createPairingCode(prisma, { createdBy: 'admin-1', now });
    const w1 = await pairWorker(
      prisma,
      { pairingCode: c1.code, workerVersion: '0.1.0', hostname: 'pc-1', os: 'Win 11', gpu: null },
      now,
    );
    const w2 = await pairWorker(
      prisma,
      { pairingCode: c2.code, workerVersion: '0.1.0', hostname: 'pc-2', os: 'Win 11', gpu: null },
      now,
    );
    await prisma.jobs.updateMany({
      where: { kind: 'worker_selftest', job_scope: w2.workerId },
      data: { status: 'cancelled' },
    });

    const bClaim = await claimJob(prisma, {
      lane: 'gpu',
      kinds: GPU_JOB_KINDS,
      workerId: w2.workerId,
      forWorker: w2.workerId,
      leaseSeconds: 600,
    });
    expect(bClaim).toBeNull();

    const aClaim = await claimJob(prisma, {
      lane: 'gpu',
      kinds: GPU_JOB_KINDS,
      workerId: w1.workerId,
      forWorker: w1.workerId,
      leaseSeconds: 600,
    });
    expect(aClaim?.kind).toBe('worker_selftest');
    expect(aClaim?.job_scope).toBe(w1.workerId);
  });

  it('revoke re-queues leased jobs and marks exhausted jobs dead', async () => {
    const now = new Date();
    const c = await createPairingCode(prisma, { createdBy: 'admin-1', now });
    const w = await pairWorker(
      prisma,
      { pairingCode: c.code, workerVersion: '0.1.0', hostname: 'pc-r', os: 'Win 11', gpu: null },
      now,
    );

    const { job: jRetry } = await enqueueJob(prisma, {
      kind: 'worker_selftest',
      scope: w.workerId,
      idempotencyKey: `revoke-retry:${w.workerId}`,
      payload: { workerId: w.workerId },
      maxAttempts: 2,
    });
    const { job: jDead } = await enqueueJob(prisma, {
      kind: 'worker_selftest',
      scope: w.workerId,
      idempotencyKey: `revoke-dead:${w.workerId}`,
      payload: { workerId: w.workerId },
      maxAttempts: 1,
    });

    // Claim both (cancel the initial selftest first so only these two are queued).
    await prisma.jobs.updateMany({
      where: { idempotency_key: `selftest:${w.workerId}` },
      data: { status: 'cancelled' },
    });
    await claimJob(prisma, {
      lane: 'gpu',
      kinds: GPU_JOB_KINDS,
      workerId: w.workerId,
      forWorker: w.workerId,
      leaseSeconds: 600,
    });
    await claimJob(prisma, {
      lane: 'gpu',
      kinds: GPU_JOB_KINDS,
      workerId: w.workerId,
      forWorker: w.workerId,
      leaseSeconds: 600,
    });

    const rev = await revokeWorker(prisma, w.workerId, 'admin-1', 'laptop lost');
    expect(rev.requeuedJobs).toBe(2);

    const retryRow = await prisma.jobs.findUniqueOrThrow({ where: { id: jRetry.id } });
    const deadRow = await prisma.jobs.findUniqueOrThrow({ where: { id: jDead.id } });
    expect(retryRow).toMatchObject({
      status: 'queued',
      leased_by: null,
      lease_id: null,
      error_code: 'worker_revoked',
      attempts: 1,
    });
    expect(deadRow).toMatchObject({
      status: 'dead',
      leased_by: null,
      lease_id: null,
      error_code: 'worker_revoked',
      attempts: 1,
    });
  });
});
