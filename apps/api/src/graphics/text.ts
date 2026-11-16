import type opentype from 'opentype.js';

export class GraphicError extends Error {
  constructor(
    readonly code:
      | 'unknown_template'
      | 'unknown_aspect'
      | 'missing_data'
      | 'text_overflow'
      | 'photo_missing'
      | 'photo_too_small'
      | 'photo_not_usable'
      | 'unknown_flag'
      | 'bad_fen'
      | 'verification_failed',
    message: string,
  ) {
    super(message);
    this.name = 'GraphicError';
  }
}

export interface TextStyle {
  font: opentype.Font;
  tracking: number;
  textCase: 'none' | 'upper';
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Width of a string at a size, with kerning and tracking, in pixels. */
export function measure(text: string, size: number, style: TextStyle): number {
  const { font, tracking } = style;
  const glyphs = font.stringToGlyphs(text);
  const scale = size / font.unitsPerEm;
  let w = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    w += (g.advanceWidth ?? 0) * scale;
    if (i < glyphs.length - 1) {
      w += font.getKerningValue(g, glyphs[i + 1]!) * scale + tracking * size;
    }
  }
  return w;
}

export function wrap(text: string, maxWidth: number, size: number, style: TextStyle): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measure(candidate, size, style) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface TextBox {
  w: number;
  h: number;
  size: { max: number; min: number };
  maxLines: number;
  lineHeight: number;
  overflow: 'error' | 'ellipsis';
}

export interface FittedText {
  lines: string[];
  size: number;
  truncated: boolean;
}

const fits = (lines: string[], box: TextBox, size: number, style: TextStyle): boolean =>
  lines.length <= box.maxLines &&
  lines.length * size * box.lineHeight <= box.h + 0.01 &&
  lines.every((l) => measure(l, size, style) <= box.w + 0.01);

/**
 * Wraps text into its region at the largest size that fits, shrinking down to the template's minimum.
 * Text that still does not fit fails (`text_overflow`) unless the template allows an ellipsis for it.
 */
export function fitText(raw: string, box: TextBox, style: TextStyle, label: string): FittedText {
  const text = (style.textCase === 'upper' ? raw.toUpperCase() : raw).replace(/\s+/g, ' ').trim();
  for (let size = box.size.max; size >= box.size.min - 0.001; size -= 1) {
    const lines = wrap(text, box.w, size, style);
    if (fits(lines, box, size, style)) return { lines, size, truncated: false };
  }
  const min = box.size.min;
  if (box.overflow === 'ellipsis') {
    const lines = wrap(text, box.w, min, style).slice(0, box.maxLines);
    let last = lines[lines.length - 1] ?? '';
    while (last.length > 1 && measure(`${last}…`, min, style) > box.w)
      last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
    if (fits(lines, box, min, style)) return { lines, size: min, truncated: true };
  }
  throw new GraphicError(
    'text_overflow',
    `"${label}" does not fit its ${box.w}x${box.h} region at ${min}px (${box.maxLines} line(s)): ${text.slice(0, 80)}`,
  );
}

/** SVG path data for fitted lines, placed in the region. Glyph outlines only, so no font is needed to draw it. */
export function textPath(
  fitted: FittedText,
  box: TextBox & { x: number; y: number },
  style: TextStyle,
  align: 'left' | 'center' | 'right',
  valign: 'top' | 'middle' | 'bottom',
): string {
  const { font, tracking } = style;
  const scale = fitted.size / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const descent = -font.descender * scale;
  const lh = fitted.size * box.lineHeight;
  const blockH = fitted.lines.length * lh;
  const top =
    valign === 'top'
      ? box.y
      : valign === 'bottom'
        ? box.y + box.h - blockH
        : box.y + (box.h - blockH) / 2;
  const parts: string[] = [];
  fitted.lines.forEach((line, i) => {
    const width = measure(line, fitted.size, style);
    let x =
      align === 'left'
        ? box.x
        : align === 'right'
          ? box.x + box.w - width
          : box.x + (box.w - width) / 2;
    const baseline = top + i * lh + (lh - (ascent + descent)) / 2 + ascent;
    const glyphs = font.stringToGlyphs(line);
    glyphs.forEach((g, gi) => {
      parts.push(g.getPath(round(x), round(baseline), fitted.size).toPathData(2));
      x += (g.advanceWidth ?? 0) * scale;
      const next = glyphs[gi + 1];
      if (next) x += font.getKerningValue(g, next) * scale + tracking * fitted.size;
    });
  });
  return parts.filter(Boolean).join(' ');
}
