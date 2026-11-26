import { describe, expect, it } from 'vitest';
import { formatLogLine } from '../../../apps/worker/src/log.js';

describe('worker log masking', () => {
  it('masks device tokens in messages and objects, plus sensitive keys', () => {
    const token = 'smbw_abcdefghijklmnopqrstuvwxyz012345';
    const line = formatLogLine('info', `authenticated with ${token}`, {
      deviceToken: token,
      authorization: `Bearer ${token}`,
      nested: { pairingCode: 'ABCD-EFGH', note: `saw ${token}` },
      hostname: 'pc-1',
    });

    expect(line).not.toContain(token);
    expect(line).not.toContain('ABCD-EFGH');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('pc-1');
  });
});
