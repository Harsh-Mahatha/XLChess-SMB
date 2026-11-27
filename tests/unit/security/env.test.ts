import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../apps/api/src/env.js';

const baseProd = {
  SMB_DEPLOYMENT: 'production',
  NODE_ENV: 'production',
  SMB_AI_PROVIDER: 'worker',
  DATABASE_URL: 'postgresql://postgres:postgres@db.example.com:5432/postgres?schema=smb',
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
  XLCHESS_JWT_ALG: 'HS256',
  XLCHESS_JWT_SECRET: 'a'.repeat(32),
  XLCHESS_JWT_ISSUER: 'xlchess',
  XLCHESS_JWT_AUDIENCE: 'smb',
};

describe('environment separation and startup guards (D15, D16)', () => {
  it('loads development defaults and sets SMB_REQUIRE_HTTPS=false', () => {
    const env = loadEnv({});
    expect(env.SMB_DEPLOYMENT).toBe('development');
    expect(env.X_CREDENTIALS_DEPLOYMENT).toBe('development');
    expect(env.SMB_REQUIRE_HTTPS).toBe(false);
    expect(env.SMB_TRUST_PROXY).toBe(0);
    expect(env.SMB_WORKER_LEASE_SECONDS).toBe(600);
    expect(env.SMB_WORKER_POLL_SECONDS).toBe(10);
    expect(env.SMB_WORKER_LLM_MODEL).toBe('qwen3.5:9b');
    expect(env.SMB_WORKER_IMAGE_MODEL).toBe('z-image-turbo');
  });

  it('defaults SMB_REQUIRE_HTTPS=true in production and honours explicit override', () => {
    const prod = loadEnv(baseProd);
    expect(prod.SMB_REQUIRE_HTTPS).toBe(true);
    const overridden = loadEnv({ ...baseProd, SMB_REQUIRE_HTTPS: 'false' });
    expect(overridden.SMB_REQUIRE_HTTPS).toBe(false);
  });

  it('rejects X credentials labelled for a different deployment', () => {
    expect(() =>
      loadEnv({
        ...baseProd,
        X_CREDENTIALS_DEPLOYMENT: 'development',
        X_API_KEY: 'k',
      }),
    ).toThrow('X credentials are labelled for development but this is production');
  });

  it('rejects production without NODE_ENV=production', () => {
    expect(() => loadEnv({ ...baseProd, NODE_ENV: 'development' })).toThrow('NODE_ENV=production');
  });

  it('rejects production when JWT settings are missing or HS256 secret is too short', () => {
    expect(() => loadEnv({ ...baseProd, XLCHESS_JWT_ISSUER: '' })).toThrow('XLCHESS_JWT_ISSUER');
    expect(() => loadEnv({ ...baseProd, XLCHESS_JWT_SECRET: 'too-short' })).toThrow(
      'XLCHESS_JWT_SECRET',
    );
    expect(() =>
      loadEnv({
        ...baseProd,
        XLCHESS_JWT_ALG: 'RS256',
        XLCHESS_JWT_SECRET: '',
        XLCHESS_JWKS_URL: '',
      }),
    ).toThrow('XLCHESS_JWKS_URL');
    expect(
      loadEnv({
        ...baseProd,
        XLCHESS_JWT_ALG: 'RS256',
        XLCHESS_JWT_SECRET: '',
        XLCHESS_JWKS_URL: 'https://xlchess.example.com/.well-known/jwks.json',
      }).XLCHESS_JWT_ALG,
    ).toBe('RS256');
  });

  it('rejects production with stub AI provider', () => {
    expect(() => loadEnv({ ...baseProd, SMB_AI_PROVIDER: 'stub' })).toThrow(
      'SMB_AI_PROVIDER=worker',
    );
  });

  it('rejects production without DATABASE_URL, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(() => loadEnv({ ...baseProd, DATABASE_URL: '' })).toThrow('DATABASE_URL');
    expect(() => loadEnv({ ...baseProd, SUPABASE_URL: '' })).toThrow('SUPABASE_URL');
    expect(() => loadEnv({ ...baseProd, SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
  });
});
