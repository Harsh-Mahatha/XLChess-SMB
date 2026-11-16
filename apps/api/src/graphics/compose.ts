import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import sharp from 'sharp';
import type {
  AspectLayout,
  BoardElement,
  CreditElement,
  FlagElement,
  PhotoElement,
  RenderData,
  TemplateElement,
  TextElement,
} from '@smb/shared';
import { GRAPHICS_ASSET_DIR, loadFont } from './fonts.js';
import { GraphicError, fitText, textPath, type TextStyle } from './text.js';

const round = (n: number): number => Math.round(n * 100) / 100;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Is this element shown, given which photograph slots are filled? */
export function isShown(e: TemplateElement, filled: Set<string>): boolean {
  return !e.when || filled.has(e.when.photo) === e.when.present;
}

// ---------------------------------------------------------------------------------------------
// Chess board (pieces: Cburnett, CC BY-SA 3.0, see assets/graphics/NOTICE.md)
// ---------------------------------------------------------------------------------------------

let pieceCache: Map<string, string> | undefined;

/** Extracts every `<g id="wk">…</g>` (with nested groups) from the piece sprite. */
function pieces(): Map<string, string> {
  if (pieceCache) return pieceCache;
  const svg = readFileSync(join(GRAPHICS_ASSET_DIR, 'pieces', 'standard.svg'), 'utf8');
  const out = new Map<string, string>();
  for (const m of svg.matchAll(/<g id="([wb][kqrbnp])"/g)) {
    let depth = 0;
    const i = m.index!;
    const tag = /<g\b|<\/g>/g;
    tag.lastIndex = i;
    let t: RegExpExecArray | null;
    while ((t = tag.exec(svg))) {
      depth += t[0] === '</g>' ? -1 : 1;
      if (depth === 0) {
        out.set(m[1]!, svg.slice(i, t.index + 4).replace(/\sid="[a-z]{2}"/, ''));
        break;
      }
    }
  }
  pieceCache = out;
  return out;
}

export function boardSvg(e: BoardElement, fen: string, blackToBottom: boolean): string {
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    throw new GraphicError('bad_fen', `"${e.bind}" is not a valid position: ${fen}`);
  }
  const sq = e.size / 8;
  const flip = blackToBottom && e.orientable;
  const parts: string[] = [];
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const col = flip ? 7 - f : f;
      const row = flip ? 7 - r : r;
      const dark = (row + col) % 2 === 1;
      const x = round(e.x + f * sq);
      const y = round(e.y + r * sq);
      parts.push(
        `<rect x="${x}" y="${y}" width="${round(sq)}" height="${round(sq)}" fill="${dark ? e.dark : e.light}"/>`,
      );
      const piece = board[row]![col];
      if (piece) {
        const art = pieces().get(`${piece.color}${piece.type}`);
        if (art)
          parts.push(`<g transform="translate(${x} ${y}) scale(${round(sq / 40)})">${art}</g>`);
      }
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

export function flagSvg(iso: string): Buffer {
  try {
    return readFileSync(join(GRAPHICS_ASSET_DIR, 'flags', `${iso}.svg`));
  } catch {
    throw new GraphicError('unknown_flag', `no bundled flag for "${iso}"`);
  }
}

/** A flag rasterised to its exact box, with rounded corners when the template asks for them. */
export async function flagPng(e: FlagElement, iso: string): Promise<Buffer> {
  const w = Math.round(e.w);
  const h = Math.round(e.h);
  let img = sharp(flagSvg(iso), { density: 288 }).resize(w, h, { fit: 'cover' }).png();
  if (e.radius > 0) {
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${e.radius}" fill="#fff"/></svg>`,
    );
    img = sharp(await img.toBuffer())
      .composite([{ input: mask, blend: 'dest-in' }])
      .png();
  }
  return img.toBuffer();
}

// ---------------------------------------------------------------------------------------------
// Base layer: background, shapes, text, boards, photograph frames
// ---------------------------------------------------------------------------------------------

export interface TextPlan {
  fitted: string;
}

function textFor(e: TextElement, data: RenderData): string | undefined {
  if (e.literal !== undefined) return e.literal;
  const v = data.texts[e.bind!]?.trim();
  if (v) return v;
  if (e.required) throw new GraphicError('missing_data', `the template needs the text "${e.bind}"`);
  return undefined;
}

const styleOf = (e: {
  font: TextElement['font'];
  tracking?: number;
  textCase?: 'none' | 'upper';
}): TextStyle => ({
  font: loadFont(e.font),
  tracking: e.tracking ?? 0,
  textCase: e.textCase ?? 'none',
});

export interface BaseLayer {
  svg: string;
  flags: { element: FlagElement; iso: string }[];
  /** The photo slots that are filled, in template order. */
  slots: PhotoElement[];
  /** Notes about anything that was shortened (for the render record). */
  notes: string[];
}

/** Draws everything except photographs and flags. Throws when required data is missing or text cannot fit. */
export function buildBaseLayer(
  layout: AspectLayout,
  data: RenderData,
  filled: Set<string>,
): BaseLayer {
  const out: string[] = [];
  const flags: BaseLayer['flags'] = [];
  const slots: PhotoElement[] = [];
  const notes: string[] = [];
  const credits: string[] = [];
  for (const [slot, p] of Object.entries(data.photos)) {
    if (filled.has(slot) && p.credit) credits.push(p.credit);
  }
  out.push(`<rect width="${layout.width}" height="${layout.height}" fill="${layout.background}"/>`);

  for (const e of layout.elements) {
    if (!isShown(e, filled)) continue;
    switch (e.type) {
      case 'rect': {
        out.push(
          `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"${e.radius ? ` rx="${e.radius}"` : ''}` +
            ` fill="${e.fill ?? 'none'}"${e.stroke ? ` stroke="${e.stroke}" stroke-width="${e.strokeWidth ?? 1}"` : ''}/>`,
        );
        break;
      }
      case 'path':
        out.push(`<path d="${e.d}" fill="${e.fill}"/>`);
        break;
      case 'text': {
        const text = textFor(e, data);
        if (text === undefined) break;
        const style = styleOf(e);
        const fitted = fitText(text, e, style, e.id);
        if (fitted.truncated) notes.push(`${e.id}: shortened`);
        out.push(`<path d="${textPath(fitted, e, style, e.align, e.valign)}" fill="${e.fill}"/>`);
        break;
      }
      case 'credit': {
        out.push(...creditPath(e, credits, notes));
        break;
      }
      case 'board': {
        const fen = data.boards[e.bind];
        if (!fen) {
          if (e.required)
            throw new GraphicError('missing_data', `the template needs the board "${e.bind}"`);
          break;
        }
        out.push(boardSvg(e, fen, data.blackToBottom));
        break;
      }
      case 'flag': {
        const iso = data.flags[e.bind];
        if (!iso) {
          if (e.required)
            throw new GraphicError('missing_data', `the template needs the flag "${e.bind}"`);
          break;
        }
        flagSvg(iso); // fail early on an unknown code
        flags.push({ element: e, iso });
        break;
      }
      case 'photo': {
        slots.push(e);
        if (e.frame) {
          const f = e.frame;
          const o = f.gap + f.width / 2;
          out.push(
            `<rect x="${round(e.x - o)}" y="${round(e.y - o)}" width="${round(e.w + 2 * o)}" height="${round(e.h + 2 * o)}" fill="none" stroke="${f.colour}" stroke-width="${f.width}"/>`,
          );
        }
        break;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">` +
    out.join('') +
    `</svg>`;
  return { svg, flags, slots, notes };
}

function creditPath(e: CreditElement, credits: string[], notes: string[]): string[] {
  if (credits.length === 0) return [];
  const style = styleOf({ font: e.font });
  const fitted = fitText(
    [...new Set(credits)].join('  ·  '),
    { ...e, lineHeight: 1.25, overflow: 'error' },
    style,
    e.id,
  );
  if (fitted.truncated) notes.push(`${e.id}: shortened`);
  return [
    `<path d="${textPath(fitted, { ...e, lineHeight: 1.25, overflow: 'error' }, style, e.align, 'middle')}" fill="${e.fill}"/>`,
  ];
}

export { esc };
