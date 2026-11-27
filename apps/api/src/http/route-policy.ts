import type { Express } from 'express';

export type RouteAccess = 'public' | 'reviewer' | 'admin' | 'worker' | 'pairing';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePolicyEntry {
  method: HttpMethod;
  path: string;
  access: RouteAccess;
}

/**
 * Authoritative access matrix for every mounted HTTP route (D23).
 * Enforced by `tests/integration/db/security.test.ts`.
 */
export const ROUTE_POLICY: readonly RoutePolicyEntry[] = [
  // Public
  { method: 'GET', path: '/health', access: 'public' },
  { method: 'GET', path: '/v1/openapi.json', access: 'public' },

  // Review (reviewer or admin)
  { method: 'GET', path: '/v1/review/queue', access: 'reviewer' },
  { method: 'GET', path: '/v1/opportunities/:id', access: 'reviewer' },
  { method: 'POST', path: '/v1/candidates/:id/revisions', access: 'reviewer' },
  { method: 'POST', path: '/v1/candidates/:id/revise', access: 'reviewer' },
  { method: 'POST', path: '/v1/revisions/:id/approve', access: 'reviewer' },
  { method: 'POST', path: '/v1/opportunities/:id/reject', access: 'reviewer' },
  { method: 'POST', path: '/v1/opportunities/:id/defer', access: 'reviewer' },
  { method: 'POST', path: '/v1/opportunities/:id/regenerate', access: 'reviewer' },
  { method: 'POST', path: '/v1/opportunities/:id/request-research', access: 'reviewer' },
  { method: 'POST', path: '/v1/opportunities/:id/reopen', access: 'reviewer' },

  // Feedback (reviewer or admin)
  { method: 'GET', path: '/v1/feedback/tags', access: 'reviewer' },
  { method: 'GET', path: '/v1/feedback/summary', access: 'reviewer' },
  { method: 'GET', path: '/v1/feedback/corrections', access: 'reviewer' },

  // Publications (admin)
  { method: 'GET', path: '/v1/publications', access: 'admin' },
  { method: 'GET', path: '/v1/publications/:id', access: 'admin' },
  { method: 'POST', path: '/v1/publications/:id/retry', access: 'admin' },
  { method: 'POST', path: '/v1/publications/:id/reconcile', access: 'admin' },
  { method: 'POST', path: '/v1/publications/:id/resolve', access: 'admin' },

  // Scheduling (admin)
  { method: 'GET', path: '/v1/schedules', access: 'admin' },
  { method: 'POST', path: '/v1/schedules/suspend', access: 'admin' },
  { method: 'POST', path: '/v1/schedules/resume', access: 'admin' },
  { method: 'GET', path: '/v1/scheduler/log', access: 'admin' },
  { method: 'POST', path: '/v1/opportunities/manual', access: 'admin' },

  // Championships (admin)
  { method: 'POST', path: '/v1/championships', access: 'admin' },
  { method: 'GET', path: '/v1/championships', access: 'admin' },
  { method: 'GET', path: '/v1/championships/:id', access: 'admin' },
  { method: 'PATCH', path: '/v1/championships/:id', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/games', access: 'admin' },
  { method: 'PATCH', path: '/v1/championships/:id/games/:kind/:number', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/games/:kind/:number/confirm', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/conclude', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/phase', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/unlock', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/flags/:flagId/resolve', access: 'admin' },
  { method: 'POST', path: '/v1/championships/:id/sync', access: 'admin' },

  // Events (admin)
  { method: 'GET', path: '/v1/events', access: 'admin' },
  { method: 'GET', path: '/v1/events/:id', access: 'admin' },
  { method: 'GET', path: '/v1/event-pollers', access: 'admin' },
  { method: 'POST', path: '/v1/event-pollers/:id/run', access: 'admin' },
  { method: 'PATCH', path: '/v1/event-pollers/:id', access: 'admin' },

  // Workflow (admin)
  { method: 'GET', path: '/v1/admin/jobs', access: 'admin' },
  { method: 'POST', path: '/v1/admin/jobs/:id/cancel', access: 'admin' },
  { method: 'POST', path: '/v1/admin/jobs/:id/reprioritise', access: 'admin' },
  { method: 'GET', path: '/v1/opportunities/:id/workflow', access: 'admin' },
  { method: 'POST', path: '/v1/admin/opportunities/:id/retry', access: 'admin' },

  // Monitoring, cost and quality KPIs (admin)
  { method: 'GET', path: '/v1/admin/metrics/dashboard', access: 'admin' },
  { method: 'GET', path: '/v1/admin/metrics/streak', access: 'admin' },
  { method: 'GET', path: '/v1/admin/metrics/operations', access: 'admin' },
  { method: 'GET', path: '/v1/admin/metrics/cost', access: 'admin' },
  { method: 'GET', path: '/v1/admin/metrics/health', access: 'admin' },
  { method: 'GET', path: '/v1/admin/metrics/opportunities/:id/cost', access: 'admin' },
  { method: 'GET', path: '/v1/admin/cost-rates', access: 'admin' },
  { method: 'PUT', path: '/v1/admin/cost-rates', access: 'admin' },

  // Admin: workers, publish mode, config overrides, audit (admin)
  { method: 'POST', path: '/v1/admin/workers/pairing-codes', access: 'admin' },
  { method: 'GET', path: '/v1/admin/workers', access: 'admin' },
  { method: 'POST', path: '/v1/admin/workers/:id/pause', access: 'admin' },
  { method: 'POST', path: '/v1/admin/workers/:id/resume', access: 'admin' },
  { method: 'POST', path: '/v1/admin/workers/:id/revoke', access: 'admin' },
  { method: 'POST', path: '/v1/admin/workers/:id/selftest', access: 'admin' },
  { method: 'GET', path: '/v1/admin/publish-mode', access: 'admin' },
  { method: 'PUT', path: '/v1/admin/publish-mode', access: 'admin' },
  { method: 'GET', path: '/v1/admin/post-types/:id/config', access: 'admin' },
  { method: 'PUT', path: '/v1/admin/post-types/:id/overrides', access: 'admin' },
  { method: 'DELETE', path: '/v1/admin/post-types/:id/overrides', access: 'admin' },
  { method: 'GET', path: '/v1/admin/configs/versions', access: 'admin' },
  { method: 'GET', path: '/v1/admin/audit', access: 'admin' },

  // Worker protocol (pairing + device token)
  { method: 'POST', path: '/worker/v1/pair', access: 'pairing' },
  { method: 'POST', path: '/worker/v1/status', access: 'worker' },
  { method: 'GET', path: '/worker/v1/config', access: 'worker' },
  { method: 'POST', path: '/worker/v1/jobs/claim', access: 'worker' },
  { method: 'POST', path: '/worker/v1/jobs/:id/heartbeat', access: 'worker' },
  { method: 'POST', path: '/worker/v1/jobs/:id/complete', access: 'worker' },
  { method: 'POST', path: '/worker/v1/jobs/:id/fail', access: 'worker' },
];

interface ExpressLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
  };
  handle?: {
    stack?: ExpressLayer[];
  };
}

/** Walks an Express 5 app's router stack and returns all mounted `{ method, path }` pairs. */
export function mountedRoutes(app: Express): Array<{ method: HttpMethod; path: string }> {
  const found: Array<{ method: HttpMethod; path: string }> = [];
  const rootStack = ((app as unknown as { router?: { stack?: ExpressLayer[] } }).router?.stack ??
    []) as ExpressLayer[];

  const walk = (stack: ExpressLayer[]): void => {
    for (const layer of stack) {
      if (layer.route?.path && layer.route.methods) {
        for (const [m, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && m !== '_all') {
            found.push({ method: m.toUpperCase() as HttpMethod, path: layer.route.path });
          }
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };

  walk(rootStack);
  return found;
}
