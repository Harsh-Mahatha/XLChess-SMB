import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@smb/shared';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const app = createApp({ env, logger: createLogger(env) });

describe('api skeleton', () => {
  it('GET /health returns a valid body in dry_run by default', async () => {
    const res = await request(app).get('/health').expect(200);
    const body = HealthResponse.parse(res.body);
    expect(body.publishMode).toBe('dry_run');
  });

  it('serves an OpenAPI document that includes /health', async () => {
    const res = await request(app).get('/v1/openapi.json').expect(200);
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('uses the standard error shape for unknown routes', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('env safety', () => {
  it('refuses live publish mode without the explicit env gate', () => {
    expect(() => loadEnv({ SMB_PUBLISH_MODE: 'live' })).toThrow(/SMB_ALLOW_LIVE_PUBLISH/);
  });
  it('allows live only when both gates are set', () => {
    const e = loadEnv({ SMB_PUBLISH_MODE: 'live', SMB_ALLOW_LIVE_PUBLISH: 'true' });
    expect(e.SMB_PUBLISH_MODE).toBe('live');
  });
});
