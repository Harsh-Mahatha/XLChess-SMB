/* eslint-disable @typescript-eslint/no-explicit-any */
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

  it('serves an OpenAPI document that includes /health and /v1/publications', async () => {
    const res = await request(app).get('/v1/openapi.json').expect(200);
    expect(res.body.paths['/health']).toBeDefined();
    expect(res.body.paths['/v1/publications']).toBeDefined();
    expect(res.body.paths['/v1/schedules']).toBeDefined();
  });

  it('uses the standard error shape for unknown routes', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('publications router mounting', () => {
  it('does not mount /v1/publications without publishing deps (404)', async () => {
    const res = await request(app).get('/v1/publications').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('answers 401 without a token when publishing deps are mounted with a verifier', async () => {
    const fakeVerifier = { verify: async () => ({ userId: 'u', role: 'admin' as const }) };
    const appWithPub = createApp({
      env,
      logger: createLogger(env),
      review: { verifier: fakeVerifier as any, read: {} as any, act: {} as any },
      publishing: {} as any,
    });
    const res = await request(appWithPub).get('/v1/publications').expect(401);
    expect(res.body.error.code).toBe('invalid_token');
  });
});

describe('scheduling router mounting', () => {
  it('does not mount /v1/schedules without scheduling deps (404)', async () => {
    const res = await request(app).get('/v1/schedules').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('answers 401 without a token when scheduling deps are mounted with a verifier', async () => {
    const fakeVerifier = { verify: async () => ({ role: 'admin', userId: 'u1' }) };
    const appWithSched = createApp({
      env,
      logger: createLogger(env),
      scheduling: { verifier: fakeVerifier as any, db: {} as any, resolvers: {} as any, logger: createLogger(env) },
    });
    const res = await request(appWithSched).get('/v1/schedules').expect(401);
    expect(res.body.error.code).toBe('invalid_token');
  });
});

describe('env safety', () => {
  it('refuses live publish mode without the explicit env gate', () => {
    expect(() => loadEnv({ SMB_PUBLISH_MODE: 'live' })).toThrow(/SMB_ALLOW_LIVE_PUBLISH/);
  });
  it('allows live only when both gates are set', () => {
    const e = loadEnv({
      SMB_PUBLISH_MODE: 'live',
      SMB_ALLOW_LIVE_PUBLISH: 'true',
      X_API_KEY: 'k',
      X_API_SECRET: 's',
      X_ACCESS_TOKEN: 't',
      X_ACCESS_TOKEN_SECRET: 'ts',
      X_USER_ID: '123',
    });
    expect(e.SMB_PUBLISH_MODE).toBe('live');
  });
});
