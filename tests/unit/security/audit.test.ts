import { describe, expect, it, vi } from 'vitest';
import { scrubAuditDetails, writeAudit } from '../../../apps/api/src/audit.js';

describe('audit helper redaction', () => {
  it('scrubs nested secret keys and arrays while preserving safe fields', () => {
    const input = {
      hostname: 'rtx-pc',
      deviceToken: 'smbw_secret_value',
      nested: {
        pairingCode: 'ABCD-EFGH',
        pairing_code: 'WXYZ-2345',
        apiKey: 'key-1',
        api_key: 'key-2',
        password: 'pw',
        authorization: 'Bearer abc',
        cookie: 'sid=1',
        label: 'home-pc',
      },
      items: [
        { token: 't1', name: 'safe-1' },
        { secret: 's1', count: 2 },
      ],
    };

    const scrubbed = scrubAuditDetails(input);
    expect(scrubbed).toEqual({
      hostname: 'rtx-pc',
      deviceToken: '[REDACTED]',
      nested: {
        pairingCode: '[REDACTED]',
        pairing_code: '[REDACTED]',
        apiKey: '[REDACTED]',
        api_key: '[REDACTED]',
        password: '[REDACTED]',
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        label: 'home-pc',
      },
      items: [
        { token: '[REDACTED]', name: 'safe-1' },
        { secret: '[REDACTED]', count: 2 },
      ],
    });
    expect(input.deviceToken).toBe('smbw_secret_value');
  });

  it('writes scrubbed details through prisma audit_log.create', async () => {
    const create = vi.fn(async (arg: unknown) => arg);
    const tx = { audit_log: { create } } as unknown as Parameters<typeof writeAudit>[0];
    await writeAudit(tx, {
      actor: 'user-1',
      action: 'worker.test',
      targetType: 'worker',
      targetId: 'w-1',
      details: { label: 'pc', deviceToken: 'smbw_12345' },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        actor: 'user-1',
        action: 'worker.test',
        target_type: 'worker',
        target_id: 'w-1',
        details: { label: 'pc', deviceToken: '[REDACTED]' },
      },
    });
  });
});
