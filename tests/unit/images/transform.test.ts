import { describe, expect, it } from 'vitest';
import {
  PhotoTransform,
  TRANSFORM_SPEC_VERSION,
  transformProblems,
  transformedSize,
  psnrFromMse,
} from '@smb/shared';

const base = { spec: TRANSFORM_SPEC_VERSION, encode: { format: 'jpeg', quality: 90 } } as const;

describe('PhotoTransform', () => {
  it('accepts crop, rotate, resize and encode, and fills the rotation background', () => {
    const t = PhotoTransform.parse({
      ...base,
      crop: { left: 10, top: 20, width: 300, height: 200 },
      rotate: { degrees: 90 },
      resize: { width: 600, height: 400, fit: 'inside' },
    });
    expect(t.rotate?.background).toBe('#000000');
    expect(transformProblems(t)).toEqual([]);
  });

  it('accepts a bare re-encode', () => {
    expect(transformProblems({ spec: 1, encode: { format: 'png' } })).toEqual([]);
  });

  it.each([
    ['recolour', { ...base, colour: { saturation: 1.4 } }],
    ['blur', { ...base, blur: 3 }],
    ['sharpen', { ...base, sharpen: { sigma: 1 } }],
    ['flip', { ...base, flip: true }],
    ['composite', { ...base, composite: [{ input: 'x.png' }] }],
    ['inpaint', { ...base, inpaint: { mask: 'face' } }],
    ['upscale model', { ...base, upscale: 'esrgan' }],
  ])('refuses %s', (_name, value) => {
    const problems = transformProblems(value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/not permitted/);
  });

  it('refuses unknown fields inside a step and out-of-range values', () => {
    expect(
      transformProblems({ ...base, crop: { left: 0, top: 0, width: 10, height: 10, x: 1 } }),
    ).not.toEqual([]);
    expect(
      transformProblems({ ...base, resize: { width: 10, height: 10, fit: 'fill' } }),
    ).not.toEqual([]);
    expect(
      transformProblems({ ...base, crop: { left: -1, top: 0, width: 10, height: 10 } }),
    ).not.toEqual([]);
    expect(transformProblems({ ...base, rotate: { degrees: 720 } })).not.toEqual([]);
    expect(transformProblems({ ...base, encode: { format: 'gif' } })).not.toEqual([]);
    expect(transformProblems({ spec: 2, encode: { format: 'jpeg' } })).not.toEqual([]);
    expect(transformProblems({ spec: 1 })).not.toEqual([]);
  });
});

describe('transformedSize', () => {
  const t = (over: object) => PhotoTransform.parse({ ...base, ...over });

  it('follows crop, quarter turns and resize', () => {
    expect(transformedSize(t({}), 4000, 3000)).toEqual({ width: 4000, height: 3000 });
    expect(
      transformedSize(t({ crop: { left: 0, top: 0, width: 1000, height: 500 } }), 4000, 3000),
    ).toEqual({ width: 1000, height: 500 });
    expect(transformedSize(t({ rotate: { degrees: 90 } }), 400, 300)).toEqual({
      width: 300,
      height: 400,
    });
    expect(transformedSize(t({ rotate: { degrees: -270 } }), 400, 300)).toEqual({
      width: 300,
      height: 400,
    });
    expect(transformedSize(t({ rotate: { degrees: 180 } }), 400, 300)).toEqual({
      width: 400,
      height: 300,
    });
    expect(
      transformedSize(t({ resize: { width: 200, height: 200, fit: 'inside' } }), 400, 300),
    ).toEqual({ width: 200, height: 150 });
    expect(
      transformedSize(t({ resize: { width: 200, height: 200, fit: 'cover' } }), 400, 300),
    ).toEqual({ width: 200, height: 200 });
  });

  it('throws when the crop leaves the photo', () => {
    expect(() =>
      transformedSize(t({ crop: { left: 3500, top: 0, width: 1000, height: 100 } }), 4000, 3000),
    ).toThrow(/outside/);
  });
});

describe('psnrFromMse', () => {
  it('is infinite for identical pixels and falls as error grows', () => {
    expect(psnrFromMse(0)).toBe(Infinity);
    expect(psnrFromMse(1)).toBeGreaterThan(psnrFromMse(10));
    expect(psnrFromMse(1)).toBeCloseTo(48.13, 1);
  });
});
