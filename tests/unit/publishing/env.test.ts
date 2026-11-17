import { describe, expect, it } from 'vitest';
import { loadEnv, xCredentialsFromEnv } from '../../../apps/api/src/env.js';

describe('publishing env validation', () => {
  const validCreds = {
    X_API_KEY: 'test-api-key',
    X_API_SECRET: 'test-api-secret',
    X_ACCESS_TOKEN: 'test-access-token',
    X_ACCESS_TOKEN_SECRET: 'test-token-secret',
    X_USER_ID: '12345678',
  };

  it('loads in dry_run mode without any X credentials', () => {
    const env = loadEnv({
      SMB_PUBLISH_MODE: 'dry_run',
    });
    expect(env.SMB_PUBLISH_MODE).toBe('dry_run');
    expect(xCredentialsFromEnv(env)).toBeUndefined();
  });

  it('throws in sandbox mode when X credentials are missing', () => {
    expect(() =>
      loadEnv({
        SMB_PUBLISH_MODE: 'sandbox',
      }),
    ).toThrow(
      'SMB_PUBLISH_MODE=sandbox needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET and X_USER_ID',
    );
  });

  it('throws in live mode when credentials are missing, even if allow flag is true', () => {
    expect(() =>
      loadEnv({
        SMB_PUBLISH_MODE: 'live',
        SMB_ALLOW_LIVE_PUBLISH: 'true',
      }),
    ).toThrow(
      'SMB_PUBLISH_MODE=live needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET and X_USER_ID',
    );
  });

  it('never leaks secret values in thrown error messages', () => {
    const secretPart = 'super-secret-part';
    try {
      loadEnv({
        SMB_PUBLISH_MODE: 'sandbox',
        X_API_KEY: secretPart,
        // others missing
      });
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain(secretPart);
    }
  });

  it('loads successfully in sandbox mode with valid credentials', () => {
    const env = loadEnv({
      SMB_PUBLISH_MODE: 'sandbox',
      ...validCreds,
    });
    expect(env.SMB_PUBLISH_MODE).toBe('sandbox');
    const creds = xCredentialsFromEnv(env);
    expect(creds).toEqual({
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      accessToken: 'test-access-token',
      accessTokenSecret: 'test-token-secret',
    });
  });

  it('loads successfully in live mode with valid credentials and allow flag', () => {
    const env = loadEnv({
      SMB_PUBLISH_MODE: 'live',
      SMB_ALLOW_LIVE_PUBLISH: 'true',
      ...validCreds,
    });
    expect(env.SMB_PUBLISH_MODE).toBe('live');
    expect(xCredentialsFromEnv(env)).toBeDefined();
  });
});
