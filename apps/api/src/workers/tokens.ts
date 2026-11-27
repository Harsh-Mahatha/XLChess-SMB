import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 29-character alphabet excluding ambiguous characters 0, O, 1, I, L (D2). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Generates an 8-character pairing code formatted as `XXXX-XXXX`. */
export function generatePairingCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercases and strips whitespace and dashes before hashing (D2). */
export function normalisePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

/** Lowercase hex SHA-256 hash used for both device tokens and normalised pairing codes. */
export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Generates an opaque device token: `smbw_` followed by 32 random bytes in base64url (D1). */
export function generateDeviceToken(): string {
  return `smbw_${randomBytes(32).toString('base64url')}`;
}
