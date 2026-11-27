import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import {
  CostRateBody,
  CostRateError,
  costReport,
  dashboard,
  healthReport,
  kpiWindow,
  listCostRates,
  operationsReport,
  opportunityCost,
  setCostRate,
  uneditedStreak,
  type MetricsConfig,
} from '../../metrics/index.js';
import { HttpError } from '../errors.js';

export interface MetricsRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
  config: MetricsConfig;
  now?: () => Date;
}

export const MetricsQuery = z
  .object({
    days: z.coerce.number().int().min(1).max(366).default(30),
    postType: z.string().min(1).max(20).optional(),
  })
  .strict();
export type MetricsQuery = z.infer<typeof MetricsQuery>;

export const MetricsIdParam = z.object({ id: z.string().uuid() });

/**
 * Monitoring, cost and quality KPIs (module 1.19). Read-only except the price list. Administrators only: the
 * figures include costs, worker state and failure details.
 */
export function metricsRouter(deps: MetricsRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db, config } = deps;
  const at = (): Date => (deps.now ? deps.now() : new Date());

  router.get('/v1/admin/metrics/dashboard', ...auth, async (req: Request, res: Response) => {
    const q = MetricsQuery.parse(req.query);
    res.json(await dashboard(db, config, { days: q.days, postType: q.postType, now: at() }));
  });

  router.get('/v1/admin/metrics/streak', ...auth, async (req: Request, res: Response) => {
    const q = MetricsQuery.parse(req.query);
    res.json(await uneditedStreak(db, config, { days: q.days, postType: q.postType, now: at() }));
  });

  router.get('/v1/admin/metrics/operations', ...auth, async (req: Request, res: Response) => {
    const q = MetricsQuery.parse(req.query);
    const w = await kpiWindow(db, config.timezone, q.days, at());
    res.json(await operationsReport(db, { from: w.from, to: w.to }));
  });

  router.get('/v1/admin/metrics/cost', ...auth, async (req: Request, res: Response) => {
    const q = MetricsQuery.parse(req.query);
    res.json(await costReport(db, config, await kpiWindow(db, config.timezone, q.days, at())));
  });

  router.get('/v1/admin/metrics/health', ...auth, async (_req: Request, res: Response) => {
    res.json(await healthReport(db, config.thresholds, at()));
  });

  router.get(
    '/v1/admin/metrics/opportunities/:id/cost',
    ...auth,
    async (req: Request, res: Response) => {
      const { id } = MetricsIdParam.parse(req.params);
      const result = await opportunityCost(db, config, id);
      if (!result) throw new HttpError(404, 'not_found', 'Opportunity not found');
      res.json(result);
    },
  );

  router.get('/v1/admin/cost-rates', ...auth, async (_req: Request, res: Response) => {
    res.json({ rates: await listCostRates(db) });
  });

  router.put('/v1/admin/cost-rates', ...auth, async (req: Request, res: Response) => {
    const body = CostRateBody.parse(req.body);
    const today = (await kpiWindow(db, config.timezone, 1, at())).toDay;
    try {
      res.status(201).json(await setCostRate(db, actorOf(res).userId, body, today));
    } catch (err) {
      if (err instanceof CostRateError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  return router;
}
