import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../apps/api/src/env.js';

describe('scheduler env validation', () => {
  it('defaults scheduler enabled to false and interval to 60 seconds', () => {
    const env = loadEnv({});
    expect(env.SMB_SCHEDULER_ENABLED).toBe(false);
    expect(env.SMB_SCHEDULER_INTERVAL_SECONDS).toBe(60);
  });

  it('accepts valid custom values for scheduler env', () => {
    const env = loadEnv({
      SMB_SCHEDULER_ENABLED: 'true',
      SMB_SCHEDULER_INTERVAL_SECONDS: '120',
    });
    expect(env.SMB_SCHEDULER_ENABLED).toBe(true);
    expect(env.SMB_SCHEDULER_INTERVAL_SECONDS).toBe(120);
  });

  it('rejects interval below minimum of 10 seconds', () => {
    expect(() =>
      loadEnv({
        SMB_SCHEDULER_INTERVAL_SECONDS: '5',
      }),
    ).toThrow();
  });

  it('rejects interval above maximum of 3600 seconds', () => {
    expect(() =>
      loadEnv({
        SMB_SCHEDULER_INTERVAL_SECONDS: '7200',
      }),
    ).toThrow();
  });
});
