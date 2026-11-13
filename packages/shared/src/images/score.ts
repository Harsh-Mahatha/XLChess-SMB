import type { ImageCandidate, MatchKind } from './types.js';

/**
 * Deterministic ranking of licence-approved photos (module 1.8). Composition judged by a vision model
 * is not part of V1; this only looks at facts about the file and how well it is tied to the subject.
 */

export const SCORER_VERSION = 'image-score@1.0.0';

export interface PhotoSlot {
  minWidth: number;
  minHeight: number;
}

/** Until the templates (1.10) declare their photo slots, every photo must cover a 16:9 social card. */
export const DEFAULT_PHOTO_SLOT: PhotoSlot = { minWidth: 1200, minHeight: 675 };

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ImageScoreRejection = 'unsupported_type' | 'too_small' | 'weak_identity';

export interface ImageScore {
  eligible: boolean;
  score: number;
  rejections: ImageScoreRejection[];
  breakdown: { identity: number; resolution: number; shape: number; recency: number };
}

const IDENTITY: Record<MatchKind, number> = { wikidata_image: 1, category: 0.8, search: 0.4 };

/** A person may only be shown when the photo is tied to them by identity, not by a text search hit. */
export function identityAllowed(c: Pick<ImageCandidate, 'subject' | 'match'>): boolean {
  return c.subject.role !== 'player' || c.match !== 'search';
}

function recency(takenAt: string | undefined, now: Date): number {
  if (!takenAt) return 0.3;
  const t = Date.parse(takenAt);
  if (Number.isNaN(t)) return 0.3;
  const years = Math.max(0, (now.getTime() - t) / (365.25 * 24 * 3600 * 1000));
  return Math.max(0, 1 - years / 10);
}

export function scoreCandidate(
  c: ImageCandidate,
  slot: PhotoSlot = DEFAULT_PHOTO_SLOT,
  now: Date = new Date(),
): ImageScore {
  const rejections: ImageScoreRejection[] = [];
  if (!(ALLOWED_MIME as readonly string[]).includes(c.mime)) rejections.push('unsupported_type');
  if (c.width < slot.minWidth || c.height < slot.minHeight) rejections.push('too_small');
  if (!identityAllowed(c)) rejections.push('weak_identity');

  const ratio = c.width / c.height;
  // Very tall or very wide images lose most of the picture when cropped to a card.
  const shape = ratio >= 1.2 && ratio <= 2 ? 1 : ratio >= 0.8 && ratio < 1.2 ? 0.7 : 0.3;
  const resolution = Math.min(1, (c.width * c.height) / (3000 * 2000));
  const breakdown = {
    identity: IDENTITY[c.match],
    resolution: Math.round(resolution * 1000) / 1000,
    shape,
    recency: Math.round(recency(c.takenAt, now) * 1000) / 1000,
  };
  const score =
    breakdown.identity * 0.5 +
    breakdown.resolution * 0.25 +
    breakdown.shape * 0.15 +
    breakdown.recency * 0.1;
  return {
    eligible: rejections.length === 0,
    score: Math.round(score * 1000) / 1000,
    rejections,
    breakdown,
  };
}
