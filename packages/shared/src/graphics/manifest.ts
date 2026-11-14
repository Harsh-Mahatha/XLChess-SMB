import { z } from 'zod';

/**
 * Graphic template manifest (module 1.10). A template is data, not code: for each supported aspect ratio it
 * lists the regions of the canvas (shapes, text, flags, a chess board and photograph slots) in pixels. The
 * renderer lays text out inside its region (wrapping, then shrinking) and crops each photograph to its slot.
 * Nothing is ever drawn on top of a photograph.
 */

export const TEMPLATE_SCHEMA_VERSION = 1;

/** Bundled fonts. Text is turned into outlines from these files, so output does not depend on the host. */
export const FONT_IDS = ['display', 'display-medium', 'body', 'body-semibold', 'body-extrabold'] as const;
export const FontId = z.enum(FONT_IDS);
export type FontId = z.infer<typeof FontId>;

export const ASPECTS = ['16:9', '1:1', '4:5'] as const;
export const Aspect = z.enum(ASPECTS);
export type Aspect = z.infer<typeof Aspect>;

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'use lower-case letters, digits and _');
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a #rrggbb colour');
const px = z.number().min(0).max(8192);
const size = z.number().positive().max(8192);

/** Shown only when a photograph slot has (or has not) been filled. This is how the no-photo variant is made. */
const When = z.object({ photo: id, present: z.boolean() }).strict();

const base = { id, when: When.optional() };

export const RectElement = z
  .object({
    ...base,
    type: z.literal('rect'),
    x: px,
    y: px,
    w: size,
    h: size,
    fill: colour.optional(),
    stroke: colour.optional(),
    strokeWidth: z.number().positive().max(64).optional(),
    radius: z.number().min(0).max(512).optional(),
  })
  .strict()
  .refine((e) => e.fill || e.stroke, 'a rect needs a fill or a stroke');
export type RectElement = z.infer<typeof RectElement>;

/** A filled shape from an SVG path (absolute commands only), for marks such as the slash of a VS. */
export const PathElement = z
  .object({
    ...base,
    type: z.literal('path'),
    d: z.string().regex(/^[MLHVCZ0-9.,\s-]+$/, 'only absolute M L H V C Z commands are allowed').max(2000),
    fill: colour,
  })
  .strict();
export type PathElement = z.infer<typeof PathElement>;

export const TextElement = z
  .object({
    ...base,
    type: z.literal('text'),
    /** Key in `RenderData.texts`. Exactly one of `bind` and `literal`. */
    bind: id.optional(),
    literal: z.string().min(1).max(200).optional(),
    /** A bound text that is missing fails the render when true, and omits the element when false. */
    required: z.boolean().default(true),
    x: px,
    y: px,
    w: size,
    h: size,
    font: FontId,
    /** The largest size is tried first, then smaller ones down to `min`. */
    size: z.object({ max: size, min: size }).strict(),
    maxLines: z.number().int().min(1).max(12).default(1),
    align: z.enum(['left', 'center', 'right']).default('left'),
    valign: z.enum(['top', 'middle', 'bottom']).default('middle'),
    fill: colour,
    textCase: z.enum(['none', 'upper']).default('none'),
    /** Extra space between letters, in ems. */
    tracking: z.number().min(-0.1).max(1).default(0),
    lineHeight: z.number().min(0.8).max(2).default(1.1),
    /** `error` refuses to render text that does not fit; `ellipsis` shortens it (decorative text only). */
    overflow: z.enum(['error', 'ellipsis']).default('error'),
  })
  .strict()
  .refine((e) => (e.bind === undefined) !== (e.literal === undefined), 'give exactly one of bind and literal')
  .refine((e) => e.size.min <= e.size.max, 'size.min must not exceed size.max');
export type TextElement = z.infer<typeof TextElement>;

export const FlagElement = z
  .object({
    ...base,
    type: z.literal('flag'),
    /** Key in `RenderData.flags` (an ISO 3166-1 alpha-2 code). */
    bind: id,
    required: z.boolean().default(false),
    x: px,
    y: px,
    w: size,
    h: size,
    radius: z.number().min(0).max(64).default(0),
  })
  .strict();
export type FlagElement = z.infer<typeof FlagElement>;

export const BoardElement = z
  .object({
    ...base,
    type: z.literal('board'),
    /** Key in `RenderData.boards` (a FEN). */
    bind: id,
    required: z.boolean().default(true),
    x: px,
    y: px,
    size,
    light: colour,
    dark: colour,
    /** Draw the board from Black's side when the data says so. */
    orientable: z.boolean().default(true),
  })
  .strict();
export type BoardElement = z.infer<typeof BoardElement>;

export const PhotoElement = z
  .object({
    ...base,
    type: z.literal('photo'),
    /** The slot's name; the render data fills it by this id. */
    id,
    x: px,
    y: px,
    w: size,
    h: size,
    /** A required slot that is empty fails the render; an optional one switches `when` regions to no-photo. */
    required: z.boolean().default(false),
    /** Where the crop is centred when the photo is a different shape: 0 is left/top, 1 is right/bottom. */
    anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().default({ x: 0.5, y: 0.4 }),
    /** Photographs smaller than this are refused rather than blown up. */
    min: z.object({ width: size, height: size }).strict().optional(),
    frame: z.object({ colour, width: size, gap: z.number().min(0).max(64) }).strict().optional(),
  })
  .strict();
export type PhotoElement = z.infer<typeof PhotoElement>;

/** The photo credit line (`Photo: author / Wikimedia Commons, licence`), drawn outside every photograph. */
export const CreditElement = z
  .object({
    ...base,
    type: z.literal('credit'),
    x: px,
    y: px,
    w: size,
    h: size,
    font: FontId,
    size: z.object({ max: size, min: size }).strict(),
    maxLines: z.number().int().min(1).max(4).default(2),
    align: z.enum(['left', 'center', 'right']).default('left'),
    fill: colour,
  })
  .strict();
export type CreditElement = z.infer<typeof CreditElement>;

export const TemplateElement = z.union([
  RectElement,
  PathElement,
  TextElement,
  FlagElement,
  BoardElement,
  PhotoElement,
  CreditElement,
]);
export type TemplateElement = z.infer<typeof TemplateElement>;

export const AspectLayout = z
  .object({
    width: z.number().int().min(200).max(4096),
    height: z.number().int().min(200).max(4096),
    background: colour,
    /** Drawn in this order; photographs and flags always sit above the shapes and text of the base layer. */
    elements: z.array(TemplateElement).min(1).max(80),
  })
  .strict();
export type AspectLayout = z.infer<typeof AspectLayout>;

export const TemplateManifest = z
  .object({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    /** Other names that resolve to this template (for example `game-result`). */
    aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/)).default([]),
    name: z.string().min(1),
    /** Bump whenever the layout changes: it is part of every render's key and hash. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    aspects: z.record(Aspect, AspectLayout).refine((o) => Object.keys(o).length >= 1, 'declare at least one aspect'),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const [aspect, layout] of Object.entries(m.aspects)) {
      const ids = new Set<string>();
      for (const [i, e] of layout.elements.entries()) {
        const slotIds = new Set(
          layout.elements.filter((x): x is PhotoElement => x.type === 'photo').map((x) => x.id),
        );
        if (ids.has(e.id)) {
          ctx.addIssue({ code: 'custom', path: ['aspects', aspect, 'elements', i, 'id'], message: `duplicate id ${e.id}` });
        }
        ids.add(e.id);
        if (e.when && !slotIds.has(e.when.photo)) {
          ctx.addIssue({
            code: 'custom',
            path: ['aspects', aspect, 'elements', i, 'when'],
            message: `unknown photo slot ${e.when.photo}`,
          });
        }
        if ('x' in e && 'y' in e) {
          const w = 'w' in e ? e.w : 'size' in e && typeof e.size === 'number' ? e.size : 0;
          const h = 'h' in e ? e.h : w;
          if (e.x + w > layout.width + 0.5 || e.y + h > layout.height + 0.5) {
            ctx.addIssue({
              code: 'custom',
              path: ['aspects', aspect, 'elements', i],
              message: `${e.id} reaches outside the ${layout.width}x${layout.height} canvas`,
            });
          }
        }
      }
      // Photographs are composited above everything else, so text, flags, boards and credits placed over a slot
      // would be hidden. Reject that (shapes such as panels and frames may sit behind or around a photograph).
      const photos = layout.elements.filter((x): x is PhotoElement => x.type === 'photo');
      for (const p of photos) {
        for (const e of layout.elements) {
          if (e.type !== 'text' && e.type !== 'flag' && e.type !== 'board' && e.type !== 'credit') continue;
          if (e.when?.photo === p.id && !e.when.present) continue; // the no-photo variant fills the slot
          const w = 'w' in e ? e.w : e.size;
          const h = 'h' in e ? e.h : w;
          const overlap = e.x < p.x + p.w && e.x + w > p.x && e.y < p.y + p.h && e.y + h > p.y;
          if (overlap) {
            ctx.addIssue({
              code: 'custom',
              path: ['aspects', aspect, 'elements'],
              message: `${e.id} overlaps photograph slot ${p.id}; nothing may be drawn over a photograph`,
            });
          }
        }
      }
    }
  });
export type TemplateManifest = z.infer<typeof TemplateManifest>;

export interface PhotoSlotSpec {
  id: string;
  width: number;
  height: number;
  required: boolean;
  minWidth: number;
  minHeight: number;
}

/** The photograph slots of one aspect, for image selection (1.8) and for the renderer. */
export function photoSlots(manifest: TemplateManifest, aspect: Aspect): PhotoSlotSpec[] {
  const layout = manifest.aspects[aspect];
  if (!layout) return [];
  return layout.elements
    .filter((e): e is PhotoElement => e.type === 'photo')
    .map((e) => ({
      id: e.id,
      width: e.w,
      height: e.h,
      required: e.required,
      minWidth: e.min?.width ?? e.w,
      minHeight: e.min?.height ?? e.h,
    }));
}

/** The smallest photograph that can fill every slot of an aspect without being enlarged. */
export function minimumPhotoSize(manifest: TemplateManifest, aspect: Aspect): { minWidth: number; minHeight: number } {
  const slots = photoSlots(manifest, aspect);
  return {
    minWidth: Math.max(0, ...slots.map((s) => s.minWidth)),
    minHeight: Math.max(0, ...slots.map((s) => s.minHeight)),
  };
}

// ---------------------------------------------------------------------------------------------
// What a render is given
// ---------------------------------------------------------------------------------------------

export const RenderPhoto = z
  .object({
    /** An original or derived photograph in `media_assets`. */
    assetId: z.string().uuid(),
    /** The credit line to draw (from the licence record). */
    credit: z.string().min(1).max(300).optional(),
  })
  .strict();
export type RenderPhoto = z.infer<typeof RenderPhoto>;

export const RenderData = z
  .object({
    texts: z.record(id, z.string().max(1000)).default({}),
    /** ISO 3166-1 alpha-2 codes, lower case. */
    flags: z.record(id, z.string().regex(/^[a-z]{2}$/)).default({}),
    boards: z.record(id, z.string().min(10).max(120)).default({}),
    photos: z.record(id, RenderPhoto).default({}),
    /** Show the board from Black's side. */
    blackToBottom: z.boolean().default(false),
  })
  .strict();
export type RenderData = z.infer<typeof RenderData>;
export type RenderDataInput = z.input<typeof RenderData>;
