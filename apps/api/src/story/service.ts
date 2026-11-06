import type { Prisma, PrismaClient } from '@prisma/client';
import {
  PostTypeConfig,
  SELECTOR_VERSION,
  resolvePhase,
  type ClaimView,
  type RankedAngle,
  type SelectionOutcome,
} from '@smb/shared';
import { assertReadyForGeneration } from '../research/package.js';
import { rankStories, type HistoryEntry, type SelectionResult } from './select.js';

/**
 * Opportunities whose story was really taken: it is being written, reviewed or published.
 * A rejected, deferred, skipped or failed opportunity did not use its story, so the story is free again.
 */
export const HISTORY_STATUSES = [
  'generating',
  'awaiting_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
] as const;

export class StoryNotReadyError extends Error {
  constructor(
    public readonly opportunityId: string,
    reason: string,
  ) {
    super(`Cannot select a story for ${opportunityId}: ${reason}`);
    this.name = 'StoryNotReadyError';
  }
}

export interface StoredSelection {
  id: string;
  opportunityId: string;
  packageId: string;
  outcome: SelectionOutcome;
  angleId: string | null;
  score: number | null;
  reason: string;
  ranking: RankedAngle[];
  /** False when an earlier run of this step already stored the answer. */
  created: boolean;
}

type Row = Prisma.story_selectionsGetPayload<object>;

function toStored(row: Row, created: boolean): StoredSelection {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    packageId: row.research_package_id,
    outcome: row.outcome as SelectionOutcome,
    angleId: row.angle_id,
    score: row.score === null ? null : Number(row.score),
    reason: row.reason,
    ranking: row.ranking as unknown as RankedAngle[],
    created,
  };
}

/** Recent selections for the same post type, other than `exceptOpportunityId`, inside the window. */
export async function loadHistory(
  db: Prisma.TransactionClient | PrismaClient,
  postTypeId: string,
  windowDays: number,
  now: Date,
  exceptOpportunityId: string,
): Promise<HistoryEntry[]> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const rows = await db.story_selections.findMany({
    where: {
      outcome: 'selected',
      created_at: { gte: since },
      opportunity_id: { not: exceptOpportunityId },
      post_opportunities: {
        post_type_id: postTypeId,
        status: { in: [...HISTORY_STATUSES] },
      },
    },
    orderBy: { created_at: 'desc' },
  });
  return rows.map((r) => ({
    opportunityId: r.opportunity_id,
    angleId: r.angle_id ?? '',
    features: r.features as unknown as string[],
    fingerprint: r.fingerprint ?? '',
    chosenAt: r.created_at,
  }));
}

export interface SelectOptions {
  jobId?: string;
  now?: Date;
}

/**
 * Story-selection step for one opportunity: take its newest usable research package, rank the angles
 * against it and the recent history, store the decision with every reason, and move the opportunity on
 * (`generating` when a story was chosen, `skipped` when there is no worthwhile post).
 *
 * Runs in one transaction under a per-post-type lock, so two opportunities selecting at the same time
 * cannot both take the same story. Running it again for the same package returns the stored answer.
 */
export async function selectStory(
  db: PrismaClient,
  opportunityId: string,
  options: SelectOptions = {},
): Promise<StoredSelection> {
  const now = options.now ?? new Date();
  return db.$transaction(async (tx) => {
    const first = await tx.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.story:' + first.post_type_id}))`;

    // Read again under the lock: a concurrent run for this opportunity may have finished first.
    const opp = await tx.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
    const pkg = await tx.research_packages.findFirst({
      where: { opportunity_id: opportunityId, status: { in: ['complete', 'partial'] } },
      orderBy: { version: 'desc' },
      include: { research_claims: true },
    });
    if (!pkg) {
      throw new StoryNotReadyError(opportunityId, 'no usable research package (missing or failed)');
    }

    const existing = await tx.story_selections.findUnique({
      where: {
        opportunity_id_research_package_id: {
          opportunity_id: opportunityId,
          research_package_id: pkg.id,
        },
      },
    });
    if (existing) return toStored(existing, false);

    if (opp.status !== 'pending' && opp.status !== 'researching') {
      throw new StoryNotReadyError(
        opportunityId,
        `status is ${opp.status}, expected pending or researching`,
      );
    }

    const row = await tx.post_configs.findUniqueOrThrow({ where: { id: opp.post_config_id } });
    const config = PostTypeConfig.parse(row.config_json);
    const effective = resolvePhase(config, opp.phase);
    const claims: ClaimView[] = pkg.research_claims.map((c) => ({
      claimKey: c.claim_key,
      value: c.value,
      verification: c.verification,
      confidence: Number(c.confidence ?? 0),
      eventTime: c.event_time?.toISOString(),
    }));
    const history = await loadHistory(
      tx,
      opp.post_type_id,
      config.deduplication.windowDays,
      now,
      opportunityId,
    );

    const result: SelectionResult = rankStories({
      phase: opp.phase,
      claims,
      history,
      channels: config.channels,
      staleAfterMinutes: effective.staleAfterMinutes,
      deduplication: config.deduplication,
      storySelection: config.storySelection,
      now,
    });

    const chosen = result.selected;
    const saved = await tx.story_selections.create({
      data: {
        opportunity_id: opportunityId,
        research_package_id: pkg.id,
        outcome: result.outcome,
        angle_id: chosen?.angleId,
        fingerprint: chosen?.fingerprint,
        features: (chosen?.features ?? []) as Prisma.InputJsonValue,
        score: chosen?.score,
        reason: result.reason,
        ranking: result.ranking as unknown as Prisma.InputJsonValue,
        selector_version: SELECTOR_VERSION,
        job_id: options.jobId,
      },
    });

    // The status history is written by a database trigger; tell it who acted and why.
    await tx.$executeRaw`select set_config('smb.actor', 'story-selection', true), set_config('smb.reason', ${result.reason}, true), set_config('smb.job_id', ${options.jobId ?? ''}, true)`;
    if (opp.status === 'pending') {
      await tx.post_opportunities.update({
        where: { id: opportunityId },
        data: { status: 'researching' },
      });
    }
    await tx.post_opportunities.update({
      where: { id: opportunityId },
      data: { status: result.outcome === 'selected' ? 'generating' : 'skipped' },
    });
    return toStored(saved, true);
  });
}

/** The angle generation (module 1.7) must write about. Throws unless a story was selected for this package. */
export async function selectedAngleFor(
  db: PrismaClient,
  opportunityId: string,
  packageId: string,
): Promise<{ angleId: string; reason: string; selectionId: string }> {
  const row = await db.story_selections.findUnique({
    where: {
      opportunity_id_research_package_id: {
        opportunity_id: opportunityId,
        research_package_id: packageId,
      },
    },
  });
  if (!row) {
    throw new StoryNotReadyError(opportunityId, 'no story has been selected for this package');
  }
  if (row.outcome !== 'selected' || !row.angle_id) {
    throw new StoryNotReadyError(
      opportunityId,
      `selection outcome is ${row.outcome}: ${row.reason}`,
    );
  }
  return { angleId: row.angle_id, reason: row.reason, selectionId: row.id };
}

/**
 * The complete gate for generation (module 1.7): the research package passes `assertReadyForGeneration`
 * and a story has been selected for it. Returns the angle to write about.
 */
export async function assertReadyToGenerate(db: PrismaClient, packageId: string) {
  await assertReadyForGeneration(db, packageId);
  const pkg = await db.research_packages.findUniqueOrThrow({ where: { id: packageId } });
  return selectedAngleFor(db, pkg.opportunity_id, packageId);
}
