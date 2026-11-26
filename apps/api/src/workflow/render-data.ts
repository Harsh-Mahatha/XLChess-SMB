import type { RenderDataInput, TemplateManifest } from '@smb/shared';
import type { ChosenPhoto } from '../images/index.js';

export interface ClaimForRender {
  claimKey: string;
  value: unknown;
}

export type RenderDataResult =
  { mapped: true; data: RenderDataInput; photoSlots: string[] } | { mapped: false; reason: string };

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const asText = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const initials = (name: string): string =>
  name
    .split(/[\s,.-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .slice(0, 2)
    .join('');

const surname = (name: string): string => {
  const part = name.includes(',') ? name.split(',')[0]! : (name.trim().split(/\s+/).pop() ?? name);
  return part.trim().toLowerCase();
};

function photoFor(name: string, photos: ChosenPhoto[]): ChosenPhoto | undefined {
  const key = surname(name);
  return photos.find((p) => p.subject.role === 'player' && surname(p.subject.name) === key);
}

/**
 * Turns verified research into the words, flags and photographs a template draws (module 1.10 hand-off). Only
 * claim values and stored photographs go in: nothing comes from the model, so a graphic can never show a fact the
 * research package does not hold.
 *
 * V1 maps `player-vs-player` (a game result). Flags and ratings are left out until the research package carries a
 * verified federation and rating for each player. A template without a mapping returns `mapped: false`, and the
 * candidate goes to review without a graphic instead of with a guessed one.
 */
export function buildRenderData(
  template: TemplateManifest,
  claims: ClaimForRender[],
  photos: ChosenPhoto[],
): RenderDataResult {
  if (template.id !== 'player-vs-player') {
    return { mapped: false, reason: `no data mapping for template ${template.id}` };
  }
  const byKey = new Map(claims.map((c) => [c.claimKey, c.value]));
  const game = asRecord(byKey.get('game.result'));
  const white = asText(game?.white);
  const black = asText(game?.black);
  if (!game || !white || !black) {
    return { mapped: false, reason: 'the research has no verified game result with both players' };
  }
  const eventValue = byKey.get('event.name');
  const eventName = asText(eventValue) ?? asText(asRecord(eventValue)?.name);
  const round = asText(game.round);
  const subtitle = [eventName, round ? `Round ${round}` : undefined].filter(Boolean).join(' · ');
  const result = asText(game.result);

  const texts: Record<string, string> = {
    player_a: white,
    player_b: black,
    subtitle: subtitle || 'Chess',
    initials_a: initials(white),
    initials_b: initials(black),
    ...(result ? { result } : {}),
  };
  const photoData: NonNullable<RenderDataInput['photos']> = {};
  for (const [slot, name] of [
    ['photo_a', white],
    ['photo_b', black],
  ] as const) {
    const p = photoFor(name, photos);
    if (p) photoData[slot] = { assetId: p.assetId, credit: p.attributionText || undefined };
  }
  return {
    mapped: true,
    data: { texts, photos: photoData },
    photoSlots: Object.keys(photoData),
  };
}
