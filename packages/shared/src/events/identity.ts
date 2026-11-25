import { createHash } from 'node:crypto';
import { canonicalJson } from '../config/hash.js';
import type { DetectedEventKind, DetectedEventPayload } from './payloads.js';

/**
 * Identity of a championship game result. Equal to `championship_games.idempotency_key`,
 * so the ledger and the championship record can never disagree.
 */
export function gameIdentityKey(
  cycleKey: string,
  kind: 'classical' | 'tiebreak',
  n: number,
): string {
  return `${cycleKey}:${kind === 'tiebreak' ? 'tiebreak' : 'game'}-${n}:result`;
}

/**
 * Fields whose change means the event's facts changed (a correction).
 * Everything else (timestamps, source urls and record ids) is volatile: a change there is a replay.
 */
export const MATERIAL_FIELDS: Record<DetectedEventKind, readonly string[]> = {
  game_completed: ['identityKey', 'result', 'players', 'scoreAfter', 'verification'],
  round_completed: ['identityKey', 'round'],
  tournament_started: ['identityKey', 'name'],
  tournament_completed: ['identityKey', 'name'],
};

/** SHA-256 of the material fields in canonical JSON. */
export function materialHash(payload: DetectedEventPayload): string {
  const source = payload as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = { kind: payload.kind };
  for (const field of MATERIAL_FIELDS[payload.kind]) picked[field] = source[field];
  return createHash('sha256').update(canonicalJson(picked)).digest('hex');
}
