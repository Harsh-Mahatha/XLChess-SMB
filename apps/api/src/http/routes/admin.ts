import type { Prisma, PrismaClient } from '@prisma/client';
import { ConfigError, PublishMode, type ConfigSet } from '@smb/shared';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import { clearOverride, getActiveConfig, setOverride } from '../../config/sync.js';
import type { Env } from '../../env.js';
import { PublishModeError, getPublishModeState, setPublishMode } from '../../publishing/mode.js';
import {
  WorkerAdminError,
  createPairingCode,
  enqueueWorkerSelfTest,
  listWorkers,
  revokeWorker,
  setWorkerPaused,
} from '../../workers/index.js';
import { HttpError } from '../errors.js';

export interface AdminRouteDeps {
  verifier: TokenVerifier | undefined;
  db: PrismaClient;
  configSet: ConfigSet;
  env: Env;
  now?: () => Date;
}

export const CreatePairingCodeBody = z.object({
  label: z.string().trim().min(1).max(100).optional(),
});
export const WorkerIdParam = z.object({ id: z.string().uuid() });
export const RevokeWorkerBody = z.object({
  reason: z.string().trim().min(3).max(300),
});
export const SetPublishModeBody = z.object({
  mode: PublishMode,
  reason: z.string().trim().min(10).max(500),
  confirm: z.string().optional(),
});
export const PostTypeIdParam = z.object({ id: z.string().min(1).max(20) });
export const PutOverridesBody = z.object({ patch: z.unknown() });
export const ListConfigVersionsQuery = z.object({
  postTypeId: z.string().min(1).optional(),
});
export const ListAuditQuery = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function assertKnownPostType(configSet: ConfigSet, postTypeId: string): void {
  if (!configSet.configs.some((c) => c.config.id === postTypeId)) {
    throw new HttpError(404, 'not_found', `Unknown post type ${postTypeId}`);
  }
}

/**
 * Administration routes for workers, publish mode, post-type overrides, and the audit log.
 */
export function adminRouter(deps: AdminRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db, configSet, env } = deps;
  const at = () => (deps.now ? deps.now() : new Date());

  // ---- Workers (D13) ----

  router.post('/v1/admin/workers/pairing-codes', ...auth, async (req: Request, res: Response) => {
    const body = CreatePairingCodeBody.parse(req.body ?? {});
    const result = await createPairingCode(db, {
      label: body.label,
      createdBy: actorOf(res).userId,
      now: at(),
    });
    res.status(201).json(result);
  });

  router.get('/v1/admin/workers', ...auth, async (_req: Request, res: Response) => {
    res.json({ workers: await listWorkers(db, at()) });
  });

  router.post('/v1/admin/workers/:id/pause', ...auth, async (req: Request, res: Response) => {
    const { id } = WorkerIdParam.parse(req.params);
    try {
      res.json(await setWorkerPaused(db, id, true, actorOf(res).userId));
    } catch (err) {
      if (err instanceof WorkerAdminError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  router.post('/v1/admin/workers/:id/resume', ...auth, async (req: Request, res: Response) => {
    const { id } = WorkerIdParam.parse(req.params);
    try {
      res.json(await setWorkerPaused(db, id, false, actorOf(res).userId));
    } catch (err) {
      if (err instanceof WorkerAdminError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  router.post('/v1/admin/workers/:id/revoke', ...auth, async (req: Request, res: Response) => {
    const { id } = WorkerIdParam.parse(req.params);
    const body = RevokeWorkerBody.parse(req.body);
    try {
      res.json(await revokeWorker(db, id, actorOf(res).userId, body.reason, at()));
    } catch (err) {
      if (err instanceof WorkerAdminError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  router.post('/v1/admin/workers/:id/selftest', ...auth, async (req: Request, res: Response) => {
    const { id } = WorkerIdParam.parse(req.params);
    try {
      res.status(202).json(await enqueueWorkerSelfTest(db, id, actorOf(res).userId, at()));
    } catch (err) {
      if (err instanceof WorkerAdminError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  // ---- Publish mode (D14) ----

  router.get('/v1/admin/publish-mode', ...auth, async (_req: Request, res: Response) => {
    res.json(await getPublishModeState(db, env));
  });

  router.put('/v1/admin/publish-mode', ...auth, async (req: Request, res: Response) => {
    const body = SetPublishModeBody.parse(req.body);
    try {
      res.json(await setPublishMode(db, env, actorOf(res).userId, body));
    } catch (err) {
      if (err instanceof PublishModeError) {
        throw new HttpError(err.status, err.code, err.message, err.details);
      }
      throw err;
    }
  });

  // ---- Config overrides (D21) ----

  router.get('/v1/admin/post-types/:id/config', ...auth, async (req: Request, res: Response) => {
    const { id } = PostTypeIdParam.parse(req.params);
    assertKnownPostType(configSet, id);
    try {
      res.json(await getActiveConfig(db, id));
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new HttpError(404, 'not_found', err.message, err.issues);
      }
      throw err;
    }
  });

  router.put('/v1/admin/post-types/:id/overrides', ...auth, async (req: Request, res: Response) => {
    const { id } = PostTypeIdParam.parse(req.params);
    assertKnownPostType(configSet, id);
    const { patch } = PutOverridesBody.parse(req.body);
    try {
      const result = await setOverride(db, configSet, id, patch, `user:${actorOf(res).userId}`);
      res.json({ postTypeId: id, ...result });
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new HttpError(422, 'config_override_invalid', err.message, err.issues);
      }
      throw err;
    }
  });

  router.delete(
    '/v1/admin/post-types/:id/overrides',
    ...auth,
    async (req: Request, res: Response) => {
      const { id } = PostTypeIdParam.parse(req.params);
      assertKnownPostType(configSet, id);
      const result = await clearOverride(db, configSet, id, `user:${actorOf(res).userId}`);
      res.json({ postTypeId: id, ...result });
    },
  );

  router.get('/v1/admin/configs/versions', ...auth, async (req: Request, res: Response) => {
    const q = ListConfigVersionsQuery.parse(req.query);
    const rows = await db.post_configs.findMany({
      where: q.postTypeId ? { post_type_id: q.postTypeId } : undefined,
      orderBy: [{ created_at: 'desc' }, { version: 'desc' }],
      take: 100,
    });
    res.json({
      versions: rows.map((r) => ({
        id: r.id,
        postTypeId: r.post_type_id,
        version: r.version,
        origin: r.origin,
        isActive: r.is_active,
        fileHash: r.file_hash,
        hasOverride: r.override !== null,
        createdAt: r.created_at.toISOString(),
      })),
    });
  });

  // ---- Audit read (D22) ----

  router.get('/v1/admin/audit', ...auth, async (req: Request, res: Response) => {
    const q = ListAuditQuery.parse(req.query);
    const where: Prisma.audit_logWhereInput = {
      ...(q.actor && { actor: q.actor }),
      ...(q.action && { action: q.action }),
      ...(q.targetType && { target_type: q.targetType }),
      ...(q.targetId && { target_id: q.targetId }),
      ...(q.before && { id: { lt: BigInt(q.before) } }),
    };
    const rows = await db.audit_log.findMany({
      where,
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    res.json({
      entries: rows.map((r) => ({
        id: String(r.id),
        actor: r.actor,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details,
        createdAt: r.created_at.toISOString(),
      })),
      nextBefore: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null,
    });
  });

  return router;
}
