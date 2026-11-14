import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import opentype from 'opentype.js';
import type { FontId } from '@smb/shared';

/** Bundled assets (fonts, flags, pieces). Same depth from src/ and dist/. */
export const GRAPHICS_ASSET_DIR = resolve(import.meta.dirname, '../../assets/graphics');

const FILES: Record<FontId, string> = {
  display: 'oswald-700.woff',
  'display-medium': 'oswald-500.woff',
  body: 'inter-400.woff',
  'body-semibold': 'inter-600.woff',
  'body-extrabold': 'inter-800.woff',
};

const cache = new Map<FontId, opentype.Font>();

export function loadFont(id: FontId): opentype.Font {
  let font = cache.get(id);
  if (!font) {
    const buf = readFileSync(join(GRAPHICS_ASSET_DIR, 'fonts', FILES[id]));
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    cache.set(id, font);
  }
  return font;
}

export const FONT_FILES = FILES;
