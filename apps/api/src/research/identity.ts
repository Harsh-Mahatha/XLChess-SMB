import type { GamePlayer } from '@smb/shared';

/**
 * Name comparison key: accents removed, case and punctuation ignored, and word order ignored so
 * "Carlsen, Magnus" and "Magnus Carlsen" match.
 */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export interface Person {
  key: string;
  name: string;
  fideId?: string;
  title?: string;
  rating?: number;
}

/**
 * Resolves player records to one identity. A FIDE id is the strongest key. A record without an id
 * joins the identity of the same normalised name when some other record gave that name an id.
 * Two different FIDE ids never merge, even if the names match.
 */
export class PlayerDirectory {
  private readonly idByName = new Map<string, string>();
  /** Names seen with two different FIDE ids: a record with only that name is not attached to either. */
  private readonly ambiguous = new Set<string>();
  private readonly people = new Map<string, Person>();

  constructor(players: Iterable<GamePlayer>) {
    const all = [...players];
    for (const p of all) {
      if (!p.fideId) continue;
      const name = normaliseName(p.name);
      const known = this.idByName.get(name);
      if (known && known !== p.fideId) this.ambiguous.add(name);
      this.idByName.set(name, p.fideId);
    }
    for (const p of all) this.add(p);
  }

  keyOf(p: GamePlayer): string {
    const fide = p.fideId ?? this.idFor(p.name);
    return fide ? `fide:${fide}` : `name:${normaliseName(p.name)}`;
  }

  private idFor(name: string): string | undefined {
    const n = normaliseName(name);
    return this.ambiguous.has(n) ? undefined : this.idByName.get(n);
  }

  private add(p: GamePlayer): void {
    const key = this.keyOf(p);
    const existing = this.people.get(key);
    this.people.set(key, {
      key,
      name: existing?.name ?? p.name,
      fideId: existing?.fideId ?? p.fideId ?? this.idFor(p.name),
      title: existing?.title ?? p.title,
      // Keep the highest rating seen; the feed repeats the rating per game.
      rating: Math.max(existing?.rating ?? 0, p.rating ?? 0) || undefined,
    });
  }

  person(key: string): Person {
    const p = this.people.get(key);
    if (!p) throw new Error(`unknown player key ${key}`);
    return p;
  }

  all(): Person[] {
    return [...this.people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
