import { describe, expect, it } from 'vitest';
import {
  TemplateManifest,
  minimumPhotoSize,
  photoSlots,
  type TemplateManifest as Manifest,
} from '@smb/shared';
import {
  GraphicError,
  SAMPLE_DATA,
  TemplateRegistry,
  boardSvg,
  cropFor,
  fitText,
  loadFont,
  loadTemplates,
  measure,
  type TextBox,
  type TextStyle,
} from '../../../apps/api/src/graphics/index.js';

const style = (
  font: 'display' | 'body' = 'display',
  textCase: 'none' | 'upper' = 'none',
): TextStyle => ({
  font: loadFont(font),
  tracking: 0,
  textCase,
});
const box = (over: Partial<TextBox> = {}): TextBox => ({
  w: 400,
  h: 100,
  size: { max: 60, min: 20 },
  maxLines: 2,
  lineHeight: 1.1,
  overflow: 'error',
  ...over,
});

describe('text fitting', () => {
  it('uses the largest size that fits, and shrinks for longer text', () => {
    const short = fitText('Gukesh', box({ maxLines: 1 }), style(), 't');
    const long = fitText('Gukesh Dommaraju of India', box({ maxLines: 1 }), style(), 't');
    expect(short.size).toBe(60);
    expect(long.size).toBeLessThan(short.size);
    expect(measure(long.lines[0]!, long.size, style())).toBeLessThanOrEqual(400);
  });

  it('wraps to the allowed number of lines before shrinking below the minimum', () => {
    const r = fitText(
      'the quick brown fox jumps over the lazy dog',
      box({ h: 140, w: 360 }),
      style('body'),
      't',
    );
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.truncated).toBe(false);
  });

  it('fails instead of drawing text that does not fit', () => {
    const text =
      'an extremely long headline that cannot possibly fit into a small box at any allowed size';
    expect(() => fitText(text, box({ maxLines: 1, w: 200 }), style(), 'headline')).toThrow(
      GraphicError,
    );
    expect(() => fitText(text, box({ maxLines: 1, w: 200 }), style(), 'headline')).toThrow(
      /headline/,
    );
  });

  it('shortens with an ellipsis only where the template allows it', () => {
    const text =
      'an extremely long headline that cannot possibly fit into a small box at any allowed size';
    const r = fitText(text, box({ maxLines: 1, w: 200, overflow: 'ellipsis' }), style(), 'h');
    expect(r.truncated).toBe(true);
    expect(r.lines[0]!.endsWith('…')).toBe(true);
    expect(measure(r.lines[0]!, r.size, style())).toBeLessThanOrEqual(200);
  });

  it('upper-cases for templates that ask for it, before measuring', () => {
    const r = fitText('abc', box({ maxLines: 1 }), style('display', 'upper'), 't');
    expect(r.lines).toEqual(['ABC']);
  });

  it('measures the same every time (no host fonts involved)', () => {
    expect(measure('Sindarov', 48, style())).toBe(measure('Sindarov', 48, style()));
  });
});

describe('photograph crop', () => {
  const slot = { w: 470, h: 392 };
  it('trims the longer side to the slot shape and keeps the photograph unscaled until the resize step', () => {
    const wide = cropFor({ width: 1600, height: 1000 }, slot, { x: 0.5, y: 0.4 });
    expect(wide.height).toBe(1000);
    expect(wide.width).toBe(Math.round(1000 * (470 / 392)));
    const tall = cropFor({ width: 900, height: 1200 }, slot, { x: 0.5, y: 0.35 });
    expect(tall.width).toBe(900);
    expect(tall.height).toBe(Math.round(900 / (470 / 392)));
  });

  it('always stays inside the photograph and follows the anchor', () => {
    for (const [w, h] of [
      [1200, 675],
      [3000, 2000],
      [700, 1500],
      [1000, 1000],
    ] as const) {
      for (const a of [0, 0.35, 1]) {
        const c = cropFor({ width: w, height: h }, slot, { x: a, y: a });
        expect(c.left).toBeGreaterThanOrEqual(0);
        expect(c.top).toBeGreaterThanOrEqual(0);
        expect(c.left + c.width).toBeLessThanOrEqual(w);
        expect(c.top + c.height).toBeLessThanOrEqual(h);
      }
    }
    const top = cropFor({ width: 900, height: 1200 }, slot, { x: 0.5, y: 0 });
    const bottom = cropFor({ width: 900, height: 1200 }, slot, { x: 0.5, y: 1 });
    expect(top.top).toBe(0);
    expect(bottom.top + bottom.height).toBe(1200);
  });

  it('uses a whole photograph that already has the slot shape', () => {
    expect(cropFor({ width: 940, height: 784 }, slot, { x: 0.5, y: 0.5 })).toEqual({
      left: 0,
      top: 0,
      width: 940,
      height: 784,
    });
  });
});

describe('chess board', () => {
  const el = {
    id: 'board',
    type: 'board',
    bind: 'position',
    required: true,
    x: 0,
    y: 0,
    size: 400,
    light: '#eeeeee',
    dark: '#222222',
    orientable: true,
  } as const;
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('draws 64 squares and every piece', () => {
    const svg = boardSvg(el, start, false);
    expect(svg.match(/<rect /g)).toHaveLength(64);
    expect(svg.match(/ scale\(/g)).toHaveLength(32);
  });

  it('puts a1 on a dark square and turns the board for Black', () => {
    const svg = boardSvg(el, start, false);
    expect(svg.split('<rect ')[57]).toContain('fill="#222222"'); // first square of the last rank
    expect(boardSvg(el, start, true)).not.toBe(svg);
  });

  it('refuses an invalid position', () => {
    expect(() => boardSvg(el, 'xxxxxxxx/8/8/8/8/8/8/8 w - - 0 1', false)).toThrow(
      /not a valid position/,
    );
  });
});

describe('template manifests', () => {
  const registry = loadTemplates();

  it('ships the eight templates the feature definition lists', () => {
    expect(registry.manifests.map((m) => m.id).sort()).toEqual([
      'chess-news',
      'chess-puzzle',
      'player-ranking',
      'player-vs-player',
      'rating-movement',
      'tournament-result',
      'upcoming-tournament',
      'xlchess-update',
    ]);
    expect(registry.get('game-result').id).toBe('player-vs-player');
  });

  it('has sample data for every template', () => {
    for (const m of registry.manifests) expect(SAMPLE_DATA[m.id], m.id).toBeDefined();
  });

  it('declares the photograph slots that image selection needs', () => {
    const pvp = registry.get('player-vs-player');
    expect(photoSlots(pvp, '16:9').map((s) => s.id)).toEqual(['photo_a', 'photo_b']);
    expect(minimumPhotoSize(pvp, '16:9')).toEqual({ minWidth: 470, minHeight: 392 });
    expect(photoSlots(registry.get('chess-puzzle'), '16:9')).toEqual([]);
  });

  it('refuses an unknown template with the known names', () => {
    expect(() => registry.get('nope')).toThrow(/known: .*player-vs-player/);
  });

  const base = (elements: unknown[]): unknown => ({
    schemaVersion: 1,
    id: 'test-template',
    name: 'Test',
    version: '1.0.0',
    description: 'Test',
    aspects: { '16:9': { width: 1200, height: 675, background: '#000000', elements } },
  });
  const photo = { id: 'p', type: 'photo', x: 100, y: 100, w: 300, h: 300 };
  const text = {
    id: 't',
    type: 'text',
    literal: 'x',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    font: 'display',
    size: { max: 20, min: 10 },
    fill: '#ffffff',
  };

  it('rejects text placed over a photograph', () => {
    const r = TemplateManifest.safeParse(base([photo, { ...text, x: 150, y: 150 }]));
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toContain(
      'nothing may be drawn over a photograph',
    );
  });

  it('allows a no-photo variant in the slot, and frames and panels around it', () => {
    const ok = TemplateManifest.safeParse(
      base([
        photo,
        { ...text, x: 150, y: 150, when: { photo: 'p', present: false } },
        { id: 'panel', type: 'rect', x: 0, y: 0, w: 600, h: 675, fill: '#111111' },
      ]),
    );
    expect(ok.success).toBe(true);
  });

  it('rejects unknown slots, duplicate ids, off-canvas elements, unknown fonts and extra fields', () => {
    const bad = (els: unknown[]) => TemplateManifest.safeParse(base(els)).success;
    expect(bad([{ ...text, when: { photo: 'missing', present: true } }])).toBe(false);
    expect(bad([text, text])).toBe(false);
    expect(bad([{ ...text, x: 1150 }])).toBe(false);
    expect(bad([{ ...text, font: 'comic-sans' }])).toBe(false);
    expect(bad([{ ...text, sparkle: true }])).toBe(false);
    expect(bad([{ ...text, bind: 'a' }])).toBe(false); // both bind and literal
  });

  it('refuses two templates sharing a name', () => {
    const m = registry.manifests[0] as Manifest;
    expect(() => new TemplateRegistry([m, m])).toThrow(/used twice/);
  });
});
