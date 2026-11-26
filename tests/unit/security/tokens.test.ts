import { describe, expect, it } from 'vitest';
import {
  PAIRING_ALPHABET,
  generateDeviceToken,
  generatePairingCode,
  hashToken,
  normalisePairingCode,
} from '../../../apps/api/src/workers/tokens.js';

describe('worker device tokens and pairing codes', () => {
  it('generates smbw_ tokens with 43 base64url characters', () => {
    const t = generateDeviceToken();
    expect(t.startsWith('smbw_')).toBe(true);
    const body = t.slice('smbw_'.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a stable 64-character lowercase hex sha256 hash', () => {
    const h1 = hashToken('smbw_test_token');
    const h2 = hashToken('smbw_test_token');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises pairing codes identically regardless of case, spaces or dashes', () => {
    const a = hashToken(normalisePairingCode('abcd efgh'));
    const b = hashToken(normalisePairingCode('ABCD-EFGH'));
    const c = hashToken(normalisePairingCode('abcdefgh'));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('excludes ambiguous characters 0, O, 1, I, L and generates 8-character XXXX-XXXX codes', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(PAIRING_ALPHABET).not.toContain(ch);
    }
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const raw = normalisePairingCode(code);
      expect(raw).toHaveLength(8);
      for (const ch of raw) expect(PAIRING_ALPHABET).toContain(ch);
    }
  });
});
