import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PhotoInspectionError, SharpPhotoInspector } from '../../../apps/api/src/images/inspect.js';
import { syntheticPhoto } from './pictures.js';

const inspector = new SharpPhotoInspector();

describe('SharpPhotoInspector', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('reads a real %s', async (format) => {
    const facts = await inspector.inspect(await syntheticPhoto(640, 480, format));
    expect(facts).toEqual({ mime: `image/${format}`, width: 640, height: 480, orientation: 1 });
  });

  it('reports the size as a viewer sees it when the camera rotated the picture', async () => {
    const facts = await inspector.inspect(
      await syntheticPhoto(640, 480, 'jpeg', { orientation: 6 }),
    );
    expect(facts).toMatchObject({ width: 480, height: 640, orientation: 6 });
  });

  it('refuses things that are not still photographs', async () => {
    await expect(
      inspector.inspect(new TextEncoder().encode('<html>hi</html>')),
    ).rejects.toMatchObject({ code: 'not_an_image' });
    const good = await syntheticPhoto(640, 480, 'jpeg');
    await expect(inspector.inspect(good.slice(0, good.length / 2))).rejects.toBeInstanceOf(
      PhotoInspectionError,
    );
    const frame = (c: number) => ({
      create: { width: 32, height: 32, channels: 3 as const, background: { r: c, g: 0, b: 0 } },
    });
    // A two-frame WebP (animated) is refused.
    const two = await sharp(
      Buffer.concat([
        await sharp(frame(0)).raw().toBuffer(),
        await sharp(frame(255)).raw().toBuffer(),
      ]),
      { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } },
    )
      .webp()
      .toBuffer();
    await expect(inspector.inspect(new Uint8Array(two))).rejects.toMatchObject({
      code: 'animated',
    });
  });
});
