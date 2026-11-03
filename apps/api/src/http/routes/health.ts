import { Router } from 'express';
import type { HealthResponse } from '@smb/shared';
import type { Env } from '../../env.js';

export function healthRouter(env: Env, version: string): Router {
  const r = Router();
  r.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'smb-api',
      version,
      publishMode: env.SMB_PUBLISH_MODE,
      time: new Date().toISOString(),
    };
    res.json(body);
  });
  return r;
}
