import { createHash } from 'node:crypto';

/** JSON with sorted object keys and no whitespace, so formatting and key order never change a hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function configHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
