import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  RenderData,
  canonicalJson,
  type Aspect,
  type PhotoElement,
  type RenderDataInput,
} from '@smb/shared';
import {
  deriveAsset,
  engineInfo,
  readVerified,
  verifyRegion,
  type AssetDeps,
} from '../assets/index.js';
import { assetLicenceProblem } from '../images/guard.js';
import { BUCKETS, IMAGE_EXTENSIONS, contentPath, sha256Hex } from '../storage/index.js';
import { buildBaseLayer, flagPng, isShown } from './compose.js';
import type { TemplateRegistry } from './registry.js';
import { GraphicError } from './text.js';

export interface RenderDeps extends AssetDeps {
  registry: TemplateRegistry;
}

export interface RenderRequest {
  /** A template id or alias, for example `player-vs-player` or `game-result`. */
  template: string;
  aspect: Aspect;
  data: RenderDataInput;
  /** When set, the render is recorded against this candidate. */
  candidateId?: string;
  /** The revision whose text the graphic shows. Approval (1.11) refuses a graphic made for a different headline. */
  revisionId?: string;
  opportunityId?: string;
  jobId?: string;
}

export interface RenderedPhoto {
  slot: string;
  /** The photograph as given. */
  assetId: string;
  /** The crop of it that sits in the graphic (the render's source). */
  derivedId: string;
  rect: { left: number; top: number; width: number; height: number };
  verified: boolean;
}

export interface RenderResult {
  assetId: string;
  sha256: string;
  path: string;
  width: number;
  height: number;
  templateId: string;
  templateVersion: string;
  aspect: Aspect;
  /** Hash of every input; the same inputs give the same key and the same file. */
  renderKey: string;
  photos: RenderedPhoto[];
  /** Text that had to be shortened, and similar things a reviewer may want to know. */
  notes: string[];
  /** False when this exact render already existed and was returned as stored. */
  created: boolean;
}

interface PreparedPhoto {
  element: PhotoElement;
  assetId: string;
  derivedId: string;
  derivedSha256: string;
  png: Uint8Array;
  credit?: string;
}

/** The crop that fills a slot from a photograph, centred on the template's anchor. */
export function cropFor(
  src: { width: number; height: number },
  slot: { w: number; h: number },
  anchor: { x: number; y: number },
): { left: number; top: number; width: number; height: number } {
  const target = slot.w / slot.h;
  let width = src.width;
  let height = src.height;
  if (src.width / src.height > target) width = Math.min(src.width, Math.round(src.height * target));
  else height = Math.min(src.height, Math.round(src.width / target));
  return {
    left: Math.round((src.width - width) * anchor.x),
    top: Math.round((src.height - height) * anchor.y),
    width,
    height,
  };
}

async function rootLicenceCredit(deps: AssetDeps, assetId: string): Promise<string | undefined> {
  const rows = await deps.db.$queryRaw<
    { id: string }[]
  >`select smb.asset_root(${assetId}::uuid) as id`;
  const rootId = rows[0]?.id;
  if (!rootId) return undefined;
  const lic = await deps.db.media_licenses.findFirst({
    where: { asset_id: rootId },
    orderBy: [{ created_at: 'desc' }, { verified_at: 'desc' }, { id: 'desc' }],
  });
  return lic?.attribution_required ? (lic.attribution_text ?? undefined) : undefined;
}

async function preparePhoto(
  deps: RenderDeps,
  element: PhotoElement,
  given: { assetId: string; credit?: string },
  ctx: { opportunityId?: string; jobId?: string },
): Promise<PreparedPhoto> {
  const asset = await deps.db.media_assets.findUnique({ where: { id: given.assetId } });
  if (!asset || (asset.kind !== 'original' && asset.kind !== 'derived')) {
    throw new GraphicError(
      'photo_not_usable',
      `slot "${element.id}": ${given.assetId} is not an original or derived photograph`,
    );
  }
  const problem = await assetLicenceProblem(deps.db, asset.id);
  if (problem) throw new GraphicError('photo_not_usable', `slot "${element.id}": ${problem}`);
  if (!asset.width || !asset.height) {
    throw new GraphicError(
      'photo_not_usable',
      `slot "${element.id}": the photograph has no recorded size`,
    );
  }
  const min = element.min ?? { width: element.w, height: element.h };
  if (asset.width < min.width || asset.height < min.height) {
    throw new GraphicError(
      'photo_too_small',
      `slot "${element.id}": the photograph is ${asset.width}x${asset.height}, below the ${min.width}x${min.height} the template needs`,
    );
  }
  const crop = cropFor({ width: asset.width, height: asset.height }, element, element.anchor);
  const derived = await deriveAsset(deps, {
    parentId: asset.id,
    transform: {
      spec: 1,
      crop,
      resize: { width: element.w, height: element.h, fit: 'cover' },
      encode: { format: 'png' },
    },
    opportunityId: ctx.opportunityId,
    jobId: ctx.jobId,
  });
  const row = await deps.db.media_assets.findUniqueOrThrow({ where: { id: derived.assetId } });
  const png = await readVerified(deps.store, row);
  // A licence that requires attribution is always honoured, whatever credit the caller passed.
  const credit = (await rootLicenceCredit(deps, asset.id)) ?? given.credit;
  return {
    element,
    assetId: asset.id,
    derivedId: derived.assetId,
    derivedSha256: derived.sha256,
    png,
    credit,
  };
}

/**
 * Renders a graphic from a template (module 1.10).
 *
 *  1. Each photograph is cut to its slot with `deriveAsset` (crop, resize, lossless PNG: the only operations
 *     allowed on a photograph), so the file in the graphic is provably made from the stored original.
 *  2. The layout (shapes, text as outlines, board) is drawn as SVG and rasterised by Sharp; flags and the cut
 *     photographs are composited on top by Sharp at exact pixel positions. Nothing is drawn over a photograph.
 *  3. The result is stored in `renders`, its photographs are recorded in `render_sources`, and every photograph
 *     area is compared with its source (`verifyRegion`). A render whose check fails is never returned as usable.
 *
 * The same inputs give the same `renderKey` and the same bytes; asking again for a candidate returns the stored one.
 */
export async function renderGraphic(deps: RenderDeps, req: RenderRequest): Promise<RenderResult> {
  const manifest = deps.registry.get(req.template);
  const layout = manifest.aspects[req.aspect];
  if (!layout) {
    throw new GraphicError(
      'unknown_aspect',
      `template ${manifest.id} has no ${req.aspect} layout (has ${Object.keys(manifest.aspects).join(', ')})`,
    );
  }
  const data = RenderData.parse(req.data);
  const slotElements = layout.elements.filter((e): e is PhotoElement => e.type === 'photo');
  for (const slot of Object.keys(data.photos)) {
    if (!slotElements.some((s) => s.id === slot)) {
      throw new GraphicError(
        'missing_data',
        `template ${manifest.id} has no photograph slot "${slot}"`,
      );
    }
  }
  for (const s of slotElements) {
    if (s.required && !data.photos[s.id]) {
      throw new GraphicError(
        'photo_missing',
        `template ${manifest.id} needs a photograph for "${s.id}"`,
      );
    }
  }

  const photos: PreparedPhoto[] = [];
  for (const el of slotElements) {
    const given = data.photos[el.id];
    if (given) photos.push(await preparePhoto(deps, el, given, req));
  }
  const filled = new Set(photos.map((p) => p.element.id));

  const templateVersion = `${manifest.id}@${manifest.version}`;
  const key = createHash('sha256')
    .update(
      canonicalJson({
        template: templateVersion,
        aspect: req.aspect,
        texts: data.texts,
        flags: data.flags,
        boards: data.boards,
        blackToBottom: data.blackToBottom,
        photos: photos.map((p) => ({
          slot: p.element.id,
          sha256: p.derivedSha256,
          credit: p.credit ?? null,
        })),
        engine: engineInfo(),
      }),
    )
    .digest('hex');

  if (req.candidateId) {
    const prior = await deps.db.candidate_renders.findUnique({
      where: {
        candidate_id_aspect_render_key: {
          candidate_id: req.candidateId,
          aspect: req.aspect,
          render_key: key,
        },
      },
    });
    if (prior)
      return storedResult(
        deps,
        prior.render_asset_id,
        manifest.id,
        templateVersion,
        req.aspect,
        key,
      );
  }

  // Compose.
  const withCredits = new Map(photos.map((p) => [p.element.id, p.credit]));
  const dataForLayout = {
    ...data,
    photos: Object.fromEntries(
      [...withCredits].map(([slot, credit]) => [
        slot,
        { assetId: data.photos[slot]!.assetId, credit },
      ]),
    ),
  };
  const base = buildBaseLayer(layout, dataForLayout, filled);
  if (
    photos.some((p) => p.credit) &&
    !layout.elements.some((e) => e.type === 'credit' && isShown(e, filled))
  ) {
    throw new GraphicError(
      'missing_data',
      `template ${manifest.id} has no credit region but a photograph's licence requires attribution`,
    );
  }
  const overlays: sharp.OverlayOptions[] = [];
  for (const f of base.flags) {
    overlays.push({
      input: await flagPng(f.element, f.iso),
      left: Math.round(f.element.x),
      top: Math.round(f.element.y),
    });
  }
  for (const p of photos) {
    overlays.push({
      input: Buffer.from(p.png),
      left: Math.round(p.element.x),
      top: Math.round(p.element.y),
    });
  }
  const bytes = new Uint8Array(
    await sharp(Buffer.from(base.svg), { density: 72 })
      .resize(layout.width, layout.height)
      .composite(overlays)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );

  const sha256 = sha256Hex(bytes);
  const path = contentPath(sha256, IMAGE_EXTENSIONS['image/png']);
  await deps.store.put(BUCKETS.renders, path, bytes, 'image/png');
  let row = await deps.db.media_assets.findUnique({
    where: { bucket_path: { bucket: BUCKETS.renders, path } },
  });
  const created = !row;
  row ??= await deps.db.media_assets.create({
    data: {
      kind: 'render',
      bucket: BUCKETS.renders,
      path,
      sha256,
      mime: 'image/png',
      size_bytes: bytes.byteLength,
      width: layout.width,
      height: layout.height,
      template_version: templateVersion,
      parent_asset_id: photos[0]?.derivedId,
      opportunity_id: req.opportunityId,
      job_id: req.jobId,
    },
  });
  if (photos.length > 0) {
    await deps.db.render_sources.createMany({
      data: photos.map((p) => ({
        render_id: row!.id,
        slot: p.element.id,
        source_id: p.derivedId,
        left_px: Math.round(p.element.x),
        top_px: Math.round(p.element.y),
        width_px: Math.round(p.element.w),
        height_px: Math.round(p.element.h),
        fit: 'cover',
      })),
      skipDuplicates: true,
    });
  }

  const checked: RenderedPhoto[] = [];
  for (const p of photos) {
    const rect = {
      left: Math.round(p.element.x),
      top: Math.round(p.element.y),
      width: Math.round(p.element.w),
      height: Math.round(p.element.h),
    };
    const report = await verifyRegion(deps, {
      renderId: row.id,
      sourceId: p.derivedId,
      rect,
      fit: 'cover',
    });
    checked.push({
      slot: p.element.id,
      assetId: p.assetId,
      derivedId: p.derivedId,
      rect,
      verified: report.passed,
    });
    if (!report.passed) {
      throw new GraphicError(
        'verification_failed',
        `the photograph in slot "${p.element.id}" does not match its source: ${report.failures.join(', ')}`,
      );
    }
  }

  if (req.candidateId) {
    await deps.db.candidate_renders.upsert({
      where: {
        candidate_id_aspect_render_key: {
          candidate_id: req.candidateId,
          aspect: req.aspect,
          render_key: key,
        },
      },
      create: {
        candidate_id: req.candidateId,
        render_asset_id: row.id,
        template_id: manifest.id,
        template_version: templateVersion,
        aspect: req.aspect,
        render_key: key,
        revision_id: req.revisionId,
      },
      update: {},
    });
  }

  return {
    assetId: row.id,
    sha256,
    path,
    width: layout.width,
    height: layout.height,
    templateId: manifest.id,
    templateVersion,
    aspect: req.aspect,
    renderKey: key,
    photos: checked,
    notes: base.notes,
    created,
  };
}

async function storedResult(
  deps: RenderDeps,
  assetId: string,
  templateId: string,
  templateVersion: string,
  aspect: Aspect,
  renderKey: string,
): Promise<RenderResult> {
  const row = await deps.db.media_assets.findUniqueOrThrow({ where: { id: assetId } });
  const sources = await deps.db.render_sources.findMany({
    where: { render_id: assetId },
    orderBy: { slot: 'asc' },
  });
  return {
    assetId,
    sha256: row.sha256,
    path: row.path,
    width: row.width!,
    height: row.height!,
    templateId,
    templateVersion,
    aspect,
    renderKey,
    photos: sources.map((s) => ({
      slot: s.slot,
      assetId: s.source_id,
      derivedId: s.source_id,
      rect: { left: s.left_px, top: s.top_px, width: s.width_px, height: s.height_px },
      verified: true,
    })),
    notes: [],
    created: false,
  };
}
