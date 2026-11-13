import type { ImageSubject } from '@smb/shared';

export interface ClaimLike {
  claim_key: string;
  value: unknown;
}

export interface SubjectPlan {
  subjects: ImageSubject[];
  /** Why a person was left out, for the result report. */
  skipped: string[];
}

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * What to look for photos of, taken from the verified research claims: the players of the game (found by
 * FIDE id), then the event and its venue. A player without a FIDE id is skipped: SMB does not guess who is
 * in a photo from a name.
 */
export function subjectsFromClaims(
  claims: ClaimLike[],
  opts: { maxPlayers?: number } = {},
): SubjectPlan {
  const maxPlayers = opts.maxPlayers ?? 2;
  const byKey = new Map(claims.map((c) => [c.claim_key, c.value]));
  const subjects: ImageSubject[] = [];
  const skipped: string[] = [];

  const participants = Array.isArray(byKey.get('participants'))
    ? (byKey.get('participants') as unknown[])
    : [];
  const people = participants.flatMap((p) => {
    const o = p as { name?: unknown; fideId?: unknown } | null;
    const name = nonEmptyString(o?.name);
    if (!name) return [];
    const fide = o?.fideId === undefined ? undefined : String(o.fideId).trim();
    return [{ name, fideId: fide && /^\d+$/.test(fide) ? fide : undefined }];
  });

  // Players named in the game or match claims come first.
  const aboutGame = ['game.result', 'match.score', 'match.situation']
    .map((k) => JSON.stringify(byKey.get(k) ?? ''))
    .join(' ')
    .toLowerCase();
  const mentioned = (n: string) => aboutGame.includes(n.toLowerCase());
  const ordered = [...people].sort((a, b) => Number(mentioned(b.name)) - Number(mentioned(a.name)));

  for (const p of ordered) {
    if (subjects.length >= maxPlayers) break;
    if (!p.fideId) {
      skipped.push(`${p.name}: no FIDE id, so no photo can be matched`);
      continue;
    }
    subjects.push({ role: 'player', name: p.name, fideId: p.fideId });
  }

  const event = nonEmptyString(byKey.get('event.name'));
  if (event) subjects.push({ role: 'event', name: event });
  const venue = nonEmptyString(byKey.get('event.venue'));
  if (venue) subjects.push({ role: 'venue', name: venue });
  return { subjects, skipped };
}
