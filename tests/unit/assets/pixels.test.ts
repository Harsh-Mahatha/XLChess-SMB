import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PhotoTransform } from '@smb/shared';
import {
  applyTransform,
  comparePixels,
  decodeOriented,
  decodeRgb,
  judgeComparison,
  TransformError,
  type RawImage,
} from '../../../apps/api/src/assets/pixels.js';
import { sha256Hex } from '../../../apps/api/src/storage/index.js';
import { syntheticPhoto } from '../images/pictures.js';

const T = (over: object = {}) =>
  PhotoTransform.parse({ spec: 1, encode: { format: 'jpeg', quality: 92 }, ...over });

async function clean() {
  const source = await syntheticPhoto(1600, 1000, 'jpeg');
  const out = await applyTransform(
    source,
    T({
      crop: { left: 100, top: 50, width: 1200, height: 800 },
      resize: { width: 900, height: 600, fit: 'inside' },
    }),
  );
  return { source, out, img: await decodeRgb(out.bytes) };
}

/** Re-encodes edited pixels as a JPEG, the way a tampered file would arrive. */
async function tampered(img: RawImage, edit: (data: Buffer, w: number, h: number) => void) {
  const data = Buffer.from(img.data);
  edit(data, img.width, img.height);
  const bytes = await sharp(data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return decodeRgb(new Uint8Array(bytes));
}

describe('applyTransform', () => {
  it('crops, resizes and re-encodes to the computed size', async () => {
    const { out } = await clean();
    expect(out).toMatchObject({ mime: 'image/jpeg', width: 900, height: 600 });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([900, 600, 'jpeg']);
  });

  it('is deterministic', async () => {
    const source = await syntheticPhoto(800, 600);
    const t = T({ rotate: { degrees: 90 }, resize: { width: 300, height: 300, fit: 'inside' } });
    const a = await applyTransform(source, t);
    const b = await applyTransform(source, t);
    expect(sha256Hex(a.bytes)).toBe(sha256Hex(b.bytes));
    expect(a).toMatchObject({ width: 225, height: 300 });
  });

  it('turns by right angles and swaps the sides', async () => {
    const source = await syntheticPhoto(800, 600);
    expect(await applyTransform(source, T({ rotate: { degrees: 90 } }))).toMatchObject({
      width: 600,
      height: 800,
    });
    expect(await applyTransform(source, T({ rotate: { degrees: 180 } }))).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it('applies the camera rotation first and drops all metadata', async () => {
    const source = await syntheticPhoto(800, 600, 'jpeg', { orientation: 6 });
    const out = await applyTransform(source, T());
    expect(out).toMatchObject({ width: 600, height: 800 });
    const meta = await sharp(out.bytes).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it('converts between formats', async () => {
    const source = await syntheticPhoto(400, 300, 'png');
    const webp = await applyTransform(source, T({ encode: { format: 'webp', quality: 90 } }));
    expect(webp.mime).toBe('image/webp');
    expect((await sharp(webp.bytes).metadata()).format).toBe('webp');
  });

  it('refuses a crop outside the photo', async () => {
    const source = await syntheticPhoto(400, 300);
    await expect(
      applyTransform(source, T({ crop: { left: 300, top: 0, width: 200, height: 100 } })),
    ).rejects.toBeInstanceOf(TransformError);
  });

  it('refuses to flatten transparency into a JPEG', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    await expect(applyTransform(new Uint8Array(png), T())).rejects.toThrow(/transparency/);
  });
});

describe('comparePixels and the integrity policy', () => {
  it('passes identical pictures and a re-encode of the same pixels', async () => {
    const { out, img } = await clean();
    const same = comparePixels(img, await decodeRgb(out.bytes));
    expect(same.psnrDb).toBe(Infinity);
    expect(judgeComparison(same)).toEqual([]);
    // What another libvips or CPU might produce: the same pixels, encoded at a different quality.
    const other = await sharp(out.bytes).jpeg({ quality: 85 }).toBuffer();
    const recoded = comparePixels(img, await decodeRgb(new Uint8Array(other)));
    expect(recoded.psnrDb).toBeGreaterThan(35);
    expect(judgeComparison(recoded)).toEqual([]);
  });

  it('catches a global recolour', async () => {
    const { img } = await clean();
    const warm = await tampered(img, (d) => {
      for (let i = 0; i < d.length; i += 3) d[i] = Math.min(255, d[i]! + 40);
    });
    expect(judgeComparison(comparePixels(img, warm))).toContain('pixel_mismatch');
  });

  it('catches a local retouch that barely moves the whole-image score', async () => {
    const { img } = await clean();
    // Brighten and smooth a face-sized patch (about 1.5 per cent of the picture).
    const edited = await tampered(img, (d, w) => {
      for (let y = 220; y < 330; y++)
        for (let x = 380; x < 520; x++) {
          const i = (y * w + x) * 3;
          for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c]! + 30);
        }
    });
    const cmp = comparePixels(img, edited);
    expect(cmp.psnrDb).toBeGreaterThan(30); // an average alone would not flag this
    expect(judgeComparison(cmp)).toContain('local_edit');
    expect(cmp.worstBlockAt.left).toBeGreaterThanOrEqual(368);
    expect(cmp.worstBlockAt.top).toBeGreaterThanOrEqual(208);
  });

  it('catches a blurred face, a pasted patch and a mirrored picture', async () => {
    const { img } = await clean();
    const w = img.width;
    const blurred = await decodeRgb(
      new Uint8Array(
        await sharp(
          await sharp(img.data, { raw: { width: w, height: img.height, channels: 3 } })
            .composite([
              {
                input: await sharp(img.data, { raw: { width: w, height: img.height, channels: 3 } })
                  .extract({ left: 340, top: 150, width: 220, height: 220 })
                  .blur(14)
                  .png()
                  .toBuffer(),
                left: 340,
                top: 150,
              },
            ])
            .png()
            .toBuffer(),
        )
          .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
          .toBuffer(),
      ),
    );
    expect(judgeComparison(comparePixels(img, blurred))).toContain('local_edit');

    const pasted = await tampered(img, (d, ww) => {
      for (let y = 100; y < 160; y++)
        for (let x = 600; x < 680; x++) {
          const i = (y * ww + x) * 3;
          d[i] = 250;
          d[i + 1] = 20;
          d[i + 2] = 20;
        }
    });
    expect(judgeComparison(comparePixels(img, pasted))).toContain('local_edit');

    const mirrored = await decodeRgb(
      new Uint8Array(
        await sharp(img.data, { raw: { width: w, height: img.height, channels: 3 } })
          .flop()
          .jpeg({ quality: 92 })
          .toBuffer(),
      ),
    );
    expect(judgeComparison(comparePixels(img, mirrored)).length).toBeGreaterThan(0);
  });

  it('rejects pictures of different sizes', async () => {
    const { img } = await clean();
    const small = await decodeOriented(await syntheticPhoto(100, 100));
    expect(() => comparePixels(img, small)).toThrow(/differ in size/);
  });
});
