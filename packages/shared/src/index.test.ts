import { describe, expect, it } from 'vitest';
import { GpuJobKind, HealthResponse } from './index.js';

describe('shared contracts', () => {
  it('accepts a valid health body', () => {
    const r = HealthResponse.safeParse({
      status: 'ok',
      service: 'smb-api',
      version: '0.1.0',
      publishMode: 'dry_run',
      time: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it('rejects unknown gpu job kinds', () => {
    expect(GpuJobKind.safeParse('nope').success).toBe(false);
  });
});
