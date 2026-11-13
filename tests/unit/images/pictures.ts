import sharp from 'sharp';

/** A deterministic test "photograph": smooth colour fields, a few shapes and fine texture, as raw RGB. */
export function syntheticRaw(width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const dx = x - width * 0.5;
      const dy = y - height * 0.45;
      const face = dx * dx + dy * dy < (Math.min(width, height) * 0.22) ** 2;
      const texture = ((x * 7 + y * 13) % 11) * 2 + ((x ^ y) & 3) * 3;
      out[i] = (face ? 205 : 40 + (x / width) * 120) + texture;
      out[i + 1] = (face ? 160 : 70 + (y / height) * 110) + texture;
      out[i + 2] = (face ? 130 : 150 - (x / width) * 60) + texture;
    }
  }
  return out;
}

export async function syntheticPhoto(
  width = 1600,
  height = 1000,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
  extra: { orientation?: number } = {},
): Promise<Uint8Array> {
  let img = sharp(syntheticRaw(width, height), { raw: { width, height, channels: 3 } });
  if (extra.orientation) img = img.withMetadata({ orientation: extra.orientation });
  const buf = await img.toFormat(format, format === 'png' ? {} : { quality: 92 }).toBuffer();
  return new Uint8Array(buf);
}
