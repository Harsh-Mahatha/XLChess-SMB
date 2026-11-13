import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_PHOTO_SLOT,
  LICENCE_POLICY_VERSION,
  PostTypeConfig,
  SCORER_VERSION,
  assessLicence,
  canonicalJson,
  scoreCandidate,
  type ImageCandidate,
  type ImageSubject,
  type LicenceAssessment,
} from '@smb/shared';
import {
  BUCKETS,
  IMAGE_EXTENSIONS,
  contentPath,
  sha1Hex,
  sha256Hex,
  sniffImageMime,
  type ImageMime,
  type ObjectStore,
} from '../storage/index.js';
import { ImageDownloadError, type ImageDownloader } from './download.js';
import type { ImageSourceRuntime } from './registry.js';
import { SharpPhotoInspector, type PhotoInspector } from './inspect.js';
import { subjectsFromClaims } from './subjects.js';

export class ImageNotReadyError extends Error {
  constructor(opportunityId: string, reason: string) {
    super(`Cannot look for images for ${opportunityId}: ${reason}`);
    this.name = 'ImageNotReadyError';
  }
}

/** Every search failed and nothing was found, so "no photo" would be a guess. The step can be retried. */
export class ImageDiscoveryError extends Error {
  constructor(readonly errors: string[]) {
    super(`Image search failed: ${errors.join('; ')}`);
    this.name = 'ImageDiscoveryError';
  }
}

export interface DiscoverDeps {
  db: PrismaClient;
  runtimes: Map<string, ImageSourceRuntime>;
  store: ObjectStore;
  downloader: ImageDownloader;
  /** Reads the real type and size of each file (Sharp by default). */
  inspector?: PhotoInspector;
  /** CC BY-SA is accepted (decision of 2026-11-13). */
  allowShareAlike?: boolean;
  /** Photos kept per opportunity, and per subject. */
  maxPhotos?: number;
  maxPerSubject?: number;
  /** Candidates asked of a source per subject. */
  searchLimit?: number;
  maxBytes?: number;
  now?: () => Date;
}

export interface ChosenPhoto {
  candidateId: string;
  assetId: string;
  licenseId: string;
  subject: ImageSubject;
  title: string;
  sourceId: string;
  sourcePageUrl: string;
  originalUrl: string;
  licence: string;
  attributionText: string;
  shareAlike: boolean;
  score: number;
  sha256: string;
  width: number;
  height: number;
}

export interface DiscoveryResult {
  status: 'found' | 'none_found' | 'not_needed';
  /** False when an earlier run's stored answer is returned. */
  created: boolean;
  /** The post type requires a photo and none could be licensed. */
  needsHuman: boolean;
  chosen: ChosenPhoto[];
  considered: number;
  rejected: number;
  errors: string[];
  skipped: string[];
}

const subjectKey = (s: ImageSubject): string => canonicalJson(s);
const candidateKey = (c: ImageCandidate): string => `${c.sourceId}|${c.externalId}`;

interface Assessed {
  candidate: ImageCandidate;
  assessment: LicenceAssessment;
  score: ReturnType<typeof scoreCandidate>;
  eligible: boolean;
}

interface Fetched {
  bytes: Uint8Array;
  sha256: string;
  mime: ImageMime;
  /** Measured from the file itself, not taken from the provider. */
  width: number;
  height: number;
}

type Db = Prisma.TransactionClient | PrismaClient;

async function storedResult(
  db: Db,
  opportunityId: string,
  need: 'required' | 'preferred' | 'none',
): Promise<DiscoveryResult | undefined> {
  const rows = await db.image_candidates.findMany({
    where: { opportunity_id: opportunityId },
    orderBy: [{ score: 'desc' }, { external_id: 'asc' }],
    include: { media_assets: true, media_licenses: true },
  });
  if (rows.length === 0) return undefined;
  const chosen: ChosenPhoto[] = rows.flatMap((r) =>
    r.chosen && r.media_assets && r.media_licenses
      ? [
          {
            candidateId: r.id,
            assetId: r.media_assets.id,
            licenseId: r.media_licenses.id,
            subject: r.subject as ImageSubject,
            title: r.title,
            sourceId: r.image_source_id,
            sourcePageUrl: r.page_url,
            originalUrl: r.image_url,
            licence: `${r.media_licenses.licence_type}${r.media_licenses.licence_version ? ` ${r.media_licenses.licence_version}` : ''}`,
            attributionText: r.media_licenses.attribution_text ?? '',
            shareAlike: r.media_licenses.share_alike,
            score: Number(r.score),
            sha256: r.media_assets.sha256,
            width: r.width,
            height: r.height,
          },
        ]
      : [],
  );
  return {
    status: chosen.length > 0 ? 'found' : 'none_found',
    created: false,
    needsHuman: chosen.length === 0 && need === 'required',
    chosen,
    considered: rows.length,
    rejected: rows.filter((r) => r.decision === 'rejected').length,
    errors: [],
    skipped: [],
  };
}

/** The photos already chosen for an opportunity, with their licences. */
export async function listChosenPhotos(
  db: PrismaClient,
  opportunityId: string,
): Promise<ChosenPhoto[]> {
  return (await storedResult(db, opportunityId, 'preferred'))?.chosen ?? [];
}

/**
 * Image step for one opportunity: find photographs of the people, event and venue in the research, check each
 * one's licence with the shared rules, keep the best licensed ones, and store them as immutable originals with
 * their licence record and evidence. Every candidate looked at is logged, including rejected ones (which are
 * never downloaded). Idempotent: a second run returns the stored answer.
 *
 * Nothing here attaches a photo to a post. That happens when a render or revision is built, and the database
 * refuses any photo whose licence is not accepted.
 */
export async function discoverImages(
  deps: DiscoverDeps,
  opportunityId: string,
): Promise<DiscoveryResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const opp = await db.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
  if (opp.status !== 'generating') {
    throw new ImageNotReadyError(opportunityId, `status is ${opp.status}, expected generating`);
  }
  const row = await db.post_configs.findUniqueOrThrow({ where: { id: opp.post_config_id } });
  const config = PostTypeConfig.parse(row.config_json);
  const need = config.imageRules.need;
  if (need === 'none') {
    return {
      status: 'not_needed',
      created: false,
      needsHuman: false,
      chosen: [],
      considered: 0,
      rejected: 0,
      errors: [],
      skipped: [],
    };
  }
  const prior = await storedResult(db, opportunityId, need);
  if (prior) return prior;

  const pkg = await db.research_packages.findFirst({
    where: { opportunity_id: opportunityId, status: { in: ['complete', 'partial'] } },
    orderBy: { version: 'desc' },
    include: { research_claims: true },
  });
  if (!pkg) throw new ImageNotReadyError(opportunityId, 'there is no research package');
  const plan = subjectsFromClaims(
    pkg.research_claims.map((c) => ({ claim_key: c.claim_key, value: c.value })),
  );

  // --- Search -------------------------------------------------------------------------------------
  const errors: string[] = [];
  const skipped = [...plan.skipped];
  const found = new Map<string, ImageCandidate>();
  let attempts = 0;
  for (const sourceId of config.imageSources) {
    const rt = deps.runtimes.get(sourceId);
    if (!rt) {
      skipped.push(`${sourceId}: not approved for automated retrieval`);
      continue;
    }
    for (const subject of plan.subjects) {
      if (!rt.entry.roles.includes(subject.role)) continue;
      attempts++;
      try {
        const list = await rt.adapter.search({ subject, limit: deps.searchLimit ?? 10 }, rt.ctx);
        for (const c of list) if (!found.has(candidateKey(c))) found.set(candidateKey(c), c);
      } catch (err) {
        errors.push(
          `${sourceId} ${subject.role}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (attempts > 0 && errors.length === attempts && found.size === 0) {
    throw new ImageDiscoveryError(errors);
  }

  // --- Decide -------------------------------------------------------------------------------------
  const assessed: Assessed[] = [...found.values()].map((candidate) => {
    const assessment = assessLicence(candidate.evidence, { allowShareAlike: deps.allowShareAlike });
    const score = scoreCandidate(candidate, DEFAULT_PHOTO_SLOT, now());
    return {
      candidate,
      assessment,
      score,
      eligible: assessment.decision === 'accepted' && score.eligible,
    };
  });
  assessed.sort(
    (a, b) =>
      b.score.score - a.score.score || a.candidate.externalId.localeCompare(b.candidate.externalId),
  );

  // --- Fetch the best licensed photos -----------------------------------------------------------------
  const inspector = deps.inspector ?? new SharpPhotoInspector();
  const maxPhotos = deps.maxPhotos ?? 3;
  const maxPerSubject = deps.maxPerSubject ?? 1;
  const perSubject = new Map<string, number>();
  const fetched = new Map<string, Fetched>();
  const downloadErrors = new Map<string, string>();
  for (const a of assessed) {
    if (fetched.size >= maxPhotos) break;
    if (!a.eligible) continue;
    const sk = subjectKey(a.candidate.subject);
    if ((perSubject.get(sk) ?? 0) >= maxPerSubject) continue;
    const rt = deps.runtimes.get(a.candidate.sourceId);
    if (!rt) continue;
    try {
      const file = await rt.limiter.run(() =>
        deps.downloader.download(a.candidate.imageUrl, {
          allowedHosts: rt.adapter.downloadHosts,
          maxBytes: deps.maxBytes ?? 50 * 1024 * 1024,
        }),
      );
      const mime = sniffImageMime(file.bytes);
      if (!mime)
        throw new ImageDownloadError('http_error', 'the file is not a JPEG, PNG or WebP image');
      if (mime !== a.candidate.mime) {
        throw new ImageDownloadError(
          'http_error',
          `the file is ${mime}, the provider said ${a.candidate.mime}`,
        );
      }
      const providerSha1 = (
        a.candidate.evidence.raw as { imageinfo?: { sha1?: string } } | undefined
      )?.imageinfo?.sha1;
      if (providerSha1 && providerSha1.toLowerCase() !== sha1Hex(file.bytes)) {
        throw new ImageDownloadError(
          'http_error',
          'the file does not match the hash the provider published',
        );
      }
      const facts = await inspector.inspect(file.bytes);
      if (facts.mime !== mime) {
        throw new ImageDownloadError('http_error', `the file is ${facts.mime}, not ${mime}`);
      }
      if (
        facts.width < DEFAULT_PHOTO_SLOT.minWidth ||
        facts.height < DEFAULT_PHOTO_SLOT.minHeight
      ) {
        throw new ImageDownloadError(
          'http_error',
          `the file is ${facts.width}x${facts.height}, below the ${DEFAULT_PHOTO_SLOT.minWidth}x${DEFAULT_PHOTO_SLOT.minHeight} minimum (the provider said ${a.candidate.width}x${a.candidate.height})`,
        );
      }
      fetched.set(candidateKey(a.candidate), {
        bytes: file.bytes,
        sha256: sha256Hex(file.bytes),
        mime,
        width: facts.width,
        height: facts.height,
      });
      perSubject.set(sk, (perSubject.get(sk) ?? 0) + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      downloadErrors.set(candidateKey(a.candidate), msg);
      errors.push(`${a.candidate.externalId}: ${msg}`);
    }
  }

  // --- Store files (content-addressed, so a repeat or a failed transaction leaves nothing wrong) -------------
  const evidenceFiles = new Map<string, { bytes: Uint8Array; sha256: string }>();
  for (const a of assessed) {
    const key = candidateKey(a.candidate);
    const file = fetched.get(key);
    if (!file) continue;
    await deps.store.put(
      BUCKETS.originals,
      contentPath(file.sha256, IMAGE_EXTENSIONS[file.mime]),
      file.bytes,
      file.mime,
    );
    const doc = new TextEncoder().encode(
      canonicalJson({
        policyVersion: LICENCE_POLICY_VERSION,
        assessment: a.assessment,
        evidence: a.candidate.evidence,
        imageUrl: a.candidate.imageUrl,
        pageUrl: a.candidate.pageUrl,
        originalSha256: file.sha256,
      }),
    );
    const sha256 = sha256Hex(doc);
    await deps.store.put(BUCKETS.evidence, contentPath(sha256, 'json'), doc, 'application/json');
    evidenceFiles.set(key, { bytes: doc, sha256 });
  }

  // --- Record -------------------------------------------------------------------------------------
  const verifiedAt = now();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.images:' + opportunityId}))`;
    const again = await storedResult(tx, opportunityId, need);
    if (again) return again;

    const chosen: ChosenPhoto[] = [];
    for (const a of assessed) {
      const c = a.candidate;
      const key = candidateKey(c);
      const file = fetched.get(key);
      const evidenceFile = evidenceFiles.get(key);
      let assetId: string | undefined;
      let licenseId: string | undefined;

      if (file && evidenceFile) {
        const path = contentPath(file.sha256, IMAGE_EXTENSIONS[file.mime]);
        const existing = await tx.media_assets.findUnique({
          where: { bucket_path: { bucket: BUCKETS.originals, path } },
        });
        const asset =
          existing ??
          (await tx.media_assets.create({
            data: {
              kind: 'original',
              bucket: BUCKETS.originals,
              path,
              sha256: file.sha256,
              mime: file.mime,
              size_bytes: file.bytes.byteLength,
              width: file.width,
              height: file.height,
              source_url: c.imageUrl,
              source_page_url: c.pageUrl,
              image_source_id: c.sourceId,
              opportunity_id: opportunityId,
            },
          }));
        if (existing?.deleted_at) {
          await tx.media_assets.update({
            where: { id: existing.id },
            data: { deleted_at: null, retention_until: null },
          });
        }
        const evPath = contentPath(evidenceFile.sha256, 'json');
        const evidenceAsset =
          (await tx.media_assets.findUnique({
            where: { bucket_path: { bucket: BUCKETS.evidence, path: evPath } },
          })) ??
          (await tx.media_assets.create({
            data: {
              kind: 'evidence',
              bucket: BUCKETS.evidence,
              path: evPath,
              sha256: evidenceFile.sha256,
              mime: 'application/json',
              size_bytes: evidenceFile.bytes.byteLength,
              opportunity_id: opportunityId,
            },
          }));
        const e = c.evidence;
        const licence = await tx.media_licenses.create({
          data: {
            asset_id: asset.id,
            original_url: c.imageUrl,
            source_page_url: c.pageUrl,
            photographer: e.author,
            copyright_holder: e.copyrightHolder,
            licence_type: a.assessment.licenceType,
            licence_version: a.assessment.licenceVersion,
            licence_url: e.licenceUrl,
            commercial_use_allowed: a.assessment.commercialUseAllowed,
            modifications_allowed: a.assessment.modificationsAllowed,
            attribution_required: a.assessment.attributionRequired,
            attribution_text: a.assessment.attributionText,
            share_alike: a.assessment.shareAlike,
            other_obligations: a.assessment.otherObligations,
            evidence_asset_id: evidenceAsset.id,
            evidence_note: e.usageTerms ? `Provider usage terms: ${e.usageTerms}` : undefined,
            decision: 'accepted',
            verified_at: verifiedAt,
            verified_by: 'system',
            policy_version: a.assessment.policyVersion,
            rejection_codes: [],
          },
        });
        assetId = asset.id;
        licenseId = licence.id;
      }

      const download = downloadErrors.get(key);
      const stored = await tx.image_candidates.create({
        data: {
          opportunity_id: opportunityId,
          image_source_id: c.sourceId,
          external_id: c.externalId,
          title: c.title,
          page_url: c.pageUrl,
          image_url: c.imageUrl,
          mime: c.mime,
          width: c.width,
          height: c.height,
          subject: c.subject as unknown as Prisma.InputJsonValue,
          match_kind: c.match,
          decision: a.assessment.decision,
          rejection_codes: a.assessment.reasons,
          decision_reason: a.assessment.reason,
          eligible: a.eligible && !download,
          score: a.score.score,
          score_detail: {
            ...a.score,
            ...(download ? { download } : {}),
            ...(file ? { inspected: { width: file.width, height: file.height } } : {}),
          } as unknown as Prisma.InputJsonValue,
          chosen: Boolean(assetId),
          evidence: c.evidence as unknown as Prisma.InputJsonValue,
          policy_version: a.assessment.policyVersion,
          scorer_version: SCORER_VERSION,
          asset_id: assetId,
          license_id: licenseId,
        },
      });
      if (assetId && licenseId) {
        chosen.push({
          candidateId: stored.id,
          assetId,
          licenseId,
          subject: c.subject,
          title: c.title,
          sourceId: c.sourceId,
          sourcePageUrl: c.pageUrl,
          originalUrl: c.imageUrl,
          licence: `${a.assessment.licenceType}${a.assessment.licenceVersion ? ` ${a.assessment.licenceVersion}` : ''}`,
          attributionText: a.assessment.attributionText ?? '',
          shareAlike: a.assessment.shareAlike,
          score: a.score.score,
          sha256: fetched.get(key)!.sha256,
          width: fetched.get(key)!.width,
          height: fetched.get(key)!.height,
        });
      }
    }

    await tx.audit_log.create({
      data: {
        actor: 'system',
        action: 'images.discover',
        target_type: 'post_opportunity',
        target_id: opportunityId,
        details: {
          considered: assessed.length,
          chosen: chosen.length,
          policyVersion: LICENCE_POLICY_VERSION,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      status: chosen.length > 0 ? 'found' : 'none_found',
      created: true,
      needsHuman: chosen.length === 0 && need === 'required',
      chosen,
      considered: assessed.length,
      rejected: assessed.filter((a) => a.assessment.decision === 'rejected').length,
      errors,
      skipped,
    } satisfies DiscoveryResult;
  });
}
