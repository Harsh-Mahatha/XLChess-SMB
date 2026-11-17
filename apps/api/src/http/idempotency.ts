import type { Request } from 'express';
import { HttpError } from './errors.js';

export function idempotencyKey(req: Request): string | undefined {
  const key = req.header('idempotency-key');
  if (key === undefined) return undefined;
  if (!/^[\x21-\x7e]{8,100}$/.test(key)) {
    throw new HttpError(
      400,
      'bad_idempotency_key',
      'Idempotency-Key must be 8 to 100 visible characters',
    );
  }
  return key;
}
