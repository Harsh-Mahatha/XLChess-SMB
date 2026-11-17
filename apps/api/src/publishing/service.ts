/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  Channel,
  PublishMode,
  PublicationAttemptOutcome,
  PublicationStatus,
} from '@smb/shared';
import type { ChannelsRegistry } from '@smb/shared';
import type { Logger } from 'pino';
import type { ObjectStore } from '../storage/index.js';
import type { Env } from '../env.js';
import { PublisherDeps, publisherFor } from './registry.js';
import { loadApprovedPost } from './package.js';
import { preflight } from './preflight.js';
import { ApprovedPost, PublishError, PublishResult } from './types.js';

export interface PublishDeps {
  db: PrismaClient;
  store: ObjectStore;
  channels: ChannelsRegistry;
  env: Pick<
    Env,
    | 'SMB_PUBLISH_MODE'
    | 'SMB_ALLOW_LIVE_PUBLISH'
    | 'X_RECONCILE_DELAY_SECONDS'
    | 'X_RECONCILE_MAX_LOOKUPS'
  >;
  publishers: PublisherDeps;
  logger: Logger;
  now?: () => Date;
  jobId?: string;
}

export const PUBLISH_TRANSITIONS = {
  start: { from: ['approved', 'scheduled'], to: 'publishing' },
  settle: {
    from: ['publishing'],
    to: ['published', 'partially_published', 'failed'],
  },
} as const;

export interface PublicationOutcome {
  publicationId: string;
  channel?: Channel;
  mode?: PublishMode;
  status: PublicationStatus;
  outcome?: string;
  skipped?: string;
  externalId?: string;
  url?: string;
  error?: string;
}

type Tx = Prisma.TransactionClient;

/** Tells the status history trigger who moved the opportunity and why. */
async function actingAs(tx: Tx, actor: string, reason: string, jobId?: string): Promise<void> {
  await tx.$executeRaw`select set_config('smb.actor', ${actor}, true), set_config('smb.reason', ${reason}, true), set_config('smb.job_id', ${jobId ?? ''}, true)`;
}

export function computeBackoff(
  attemptCount: number,
  policy: { backoffSeconds?: number; backoffMultiplier?: number },
  now: Date,
): Date {
  const baseSeconds = policy.backoffSeconds ?? 60;
  const multiplier = policy.backoffMultiplier ?? 2;
  const delaySeconds = baseSeconds * Math.pow(multiplier, Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delaySeconds * 1000);
}

/** Pure decision function for settling opportunity status from its publications. */
export function settleDecision(
  statuses: PublicationStatus[],
): 'published' | 'partially_published' | 'failed' | 'in_progress' | 'cancelled' {
  if (statuses.length === 0) return 'cancelled';

  // Any publication still in progress means the opportunity remains in progress
  if (statuses.some((s) => s === 'pending' || s === 'publishing' || s === 'uncertain')) {
    return 'in_progress';
  }

  const allFinishedOk = statuses.every((s) => s === 'published' || s === 'dry_run_recorded');
  if (allFinishedOk) {
    return 'published';
  }

  const allFailed = statuses.every((s) => s === 'failed');
  if (allFailed) {
    return 'failed';
  }

  const anyFinishedOk = statuses.some((s) => s === 'published' || s === 'dry_run_recorded');
  const anyFailed = statuses.some((s) => s === 'failed');
  if (anyFinishedOk && anyFailed) {
    return 'partially_published';
  }

  if (statuses.every((s) => s === 'cancelled')) {
    return 'cancelled';
  }

  return 'in_progress';
}

/** Pure mapping function from attempt result to next publication state. */
export function nextState(
  row: { attempt_count: number; mode: PublishMode },
  resultOrError: PublishResult | PublishError | Error,
  policy: { maxAttempts?: number; backoffSeconds?: number; backoffMultiplier?: number },
  now: Date,
): {
  nextStatus: PublicationStatus;
  retryAfter: Date | null;
  attemptDelta: number;
  outcome: PublicationAttemptOutcome;
} {
  // Successful publication or dry run
  if (
    'kind' in resultOrError &&
    (resultOrError.kind === 'published' || resultOrError.kind === 'dry_run')
  ) {
    if (resultOrError.kind === 'dry_run') {
      return {
        nextStatus: 'dry_run_recorded',
        retryAfter: null,
        attemptDelta: 0,
        outcome: 'dry_run',
      };
    }
    return {
      nextStatus: 'published',
      retryAfter: null,
      attemptDelta: 0,
      outcome: 'success',
    };
  }

  // Error handling
  if (resultOrError instanceof PublishError) {
    if (resultOrError.kind === 'before_send') {
      const maxAttempts = policy.maxAttempts ?? 3;
      if (row.attempt_count < maxAttempts) {
        return {
          nextStatus: 'pending',
          retryAfter: computeBackoff(row.attempt_count, policy, now),
          attemptDelta: 0,
          outcome: 'failure',
        };
      }
      return {
        nextStatus: 'failed',
        retryAfter: null,
        attemptDelta: 0,
        outcome: 'failure',
      };
    }

    if (resultOrError.kind === 'rate_limited') {
      const retryAt = resultOrError.retryAt ?? new Date(now.getTime() + 15 * 60 * 1000);
      return {
        nextStatus: 'pending',
        retryAfter: retryAt,
        attemptDelta: -1, // Do not count towards max attempts
        outcome: 'rate_limited',
      };
    }

    if (resultOrError.kind === 'uncertain') {
      const delay = 60 * 1000;
      return {
        nextStatus: 'uncertain',
        retryAfter: new Date(now.getTime() + delay),
        attemptDelta: 0,
        outcome: resultOrError.code === 'duplicate_content' ? 'refused' : 'timeout',
      };
    }

    if (resultOrError.kind === 'permanent') {
      return {
        nextStatus: 'failed',
        retryAfter: null,
        attemptDelta: 0,
        outcome: 'refused',
      };
    }
  }

  // Any other error -> treat as uncertain
  return {
    nextStatus: 'uncertain',
    retryAfter: new Date(now.getTime() + 60 * 1000),
    attemptDelta: 0,
    outcome: 'timeout',
  };
}

/** Updates opportunity status according to its publications for the newest approval. */
export async function settleOpportunity(
  tx: Tx,
  opportunityId: string,
  now: Date,
  jobId?: string,
): Promise<void> {
  const approval = await tx.review_actions.findFirst({
    where: { opportunity_id: opportunityId, action: 'approve' },
    orderBy: { created_at: 'desc' },
  });
  if (!approval) return;

  const pubs = await tx.publications.findMany({
    where: { approval_id: approval.id },
  });

  // Ignore cancelled rows from older approvals
  const activeStatuses = pubs.map((p) => p.status as PublicationStatus);
  const decision = settleDecision(activeStatuses);

  const opp = await tx.post_opportunities.findUnique({
    where: { id: opportunityId },
  });
  if (!opp) return;

  if (decision === 'in_progress') {
    if (opp.status !== 'publishing' && ['approved', 'scheduled'].includes(opp.status)) {
      await actingAs(tx, 'system:publisher', 'publishing in progress', jobId);
      await tx.post_opportunities.update({
        where: { id: opportunityId },
        data: { status: 'publishing' },
      });
    }
    return;
  }

  if (decision === 'published') {
    const isDryRun = pubs.every((p) => p.status === 'dry_run_recorded');
    const reason = isDryRun ? 'published (dry run)' : 'published';
    await actingAs(tx, 'system:publisher', reason, jobId);
    await tx.post_opportunities.update({
      where: { id: opportunityId },
      data: { status: 'published' },
    });
    return;
  }

  if (decision === 'partially_published') {
    await actingAs(tx, 'system:publisher', 'partially published: some channels failed', jobId);
    await tx.post_opportunities.update({
      where: { id: opportunityId },
      data: { status: 'partially_published' },
    });
    return;
  }

  if (decision === 'failed') {
    await actingAs(tx, 'system:publisher', 'publishing failed on all channels', jobId);
    await tx.post_opportunities.update({
      where: { id: opportunityId },
      data: { status: 'failed' },
    });
  }
}

/** Backfill helper for approvals created before 1.13. */
export async function ensurePublications(
  db: PrismaClient,
  approvalId: string,
  mode: PublishMode,
): Promise<number> {
  const approval = await db.review_actions.findUnique({
    where: { id: approvalId },
    include: { post_opportunities: true },
  });
  if (!approval || approval.action !== 'approve') return 0;

  const opp = approval.post_opportunities;
  if (!opp || !['approved', 'scheduled'].includes(opp.status)) return 0;

  const newestApprove = await db.review_actions.findFirst({
    where: { opportunity_id: opp.id, action: 'approve' },
    orderBy: { created_at: 'desc' },
  });
  if (newestApprove?.id !== approval.id) return 0;

  const channels = (approval.channels as Channel[]) ?? [];
  let count = 0;
  for (const c of channels) {
    const existing = await db.publications.findUnique({
      where: {
        approval_id_channel: {
          approval_id: approval.id,
          channel: c,
        },
      },
    });
    if (!existing) {
      await db.publications.create({
        data: {
          approval_id: approval.id,
          revision_id: approval.revision_id!,
          channel: c,
          mode,
          status: 'pending',
          content_hash: approval.content_hash!,
          idempotency_key: `pub:${approval.id}:${c}`,
          scheduled_for: approval.scheduled_for,
        },
      });
      count++;
    }
  }
  return count;
}

/** Exactly-once publishing flow for a single publication. */
export async function publishPublication(
  deps: PublishDeps,
  publicationId: string,
): Promise<PublicationOutcome> {
  const at = deps.now ? deps.now() : new Date();

  // -----------------------------------------------------------------------------------------------
  // Transaction 1: Claim (short transaction)
  // -----------------------------------------------------------------------------------------------
  let post: ApprovedPost;
  let attemptCount = 0;
  let publishMode: PublishMode = 'dry_run';
  let publicationChannel: Channel = 'x';

  const claimResult = await deps.db.$transaction(
    async (tx) => {
      // Find opportunity id for this publication
      const initial = await tx.publications.findUnique({
        where: { id: publicationId },
        include: { review_actions: true },
      });
      if (!initial) {
        return { skipped: 'not_found' as const };
      }

      // Lock opportunity first, preventing deadlock with review actions
      await tx.$queryRaw`select id from smb.post_opportunities where id = ${initial.review_actions.opportunity_id}::uuid for update`;

      // Lock publication row with skip locked
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string; status: string; attempt_count: number; mode: string; channel: string }>
      >`select id::text, status::text, attempt_count, mode::text, channel::text from smb.publications where id = ${publicationId}::uuid for update skip locked`;

      if (lockedRows.length === 0) {
        return { skipped: 'locked' as const };
      }

      const row = lockedRows[0]!;
      publishMode = row.mode as PublishMode;
      publicationChannel = row.channel as Channel;

      if (row.status !== 'pending') {
        return { skipped: row.status as PublicationStatus };
      }

      const loadedPost = await loadApprovedPost(
        { db: tx as any, store: deps.store, channels: deps.channels },
        publicationId,
      );

      const pf = await preflight(
        {
          db: tx as any,
          store: deps.store,
          channels: deps.channels,
          env: deps.env,
          publishers: deps.publishers,
        },
        loadedPost,
        at,
      );

      if (!pf.isDue) {
        return { skipped: 'not_due' as const };
      }

      if (!pf.ok) {
        // If mode is not allowed, leave pending (transient environment issue)
        if (pf.problems.some((p) => p.code === 'mode_not_allowed')) {
          deps.logger.warn(
            { publicationId, mode: loadedPost.mode },
            'Publication mode is not allowed by current environment; leaving pending',
          );
          return { skipped: 'mode_not_allowed' as const };
        }

        const maxAttempt = await tx.publication_attempts.aggregate({
          where: { publication_id: publicationId },
          _max: { attempt_no: true },
        });
        const attemptNo = (maxAttempt._max.attempt_no ?? 0) + 1;
        const problemSummary = pf.problems.map((p) => `${p.code}: ${p.message}`).join('; ');

        await tx.publication_attempts.create({
          data: {
            publication_id: publicationId,
            attempt_no: attemptNo,
            kind: 'send',
            outcome: 'refused',
            error: problemSummary,
            request_summary: {
              channel: loadedPost.channel,
              text: loadedPost.text,
            },
            response_summary: { problems: pf.problems as unknown as Prisma.InputJsonValue },
            job_id: deps.jobId ?? null,
            started_at: at,
            finished_at: at,
          },
        });

        const cancelStatus = pf.problems.some(
          (p) => p.code === 'approval_not_in_force' || p.code === 'revision_superseded',
        );
        const nextStatus = cancelStatus ? 'cancelled' : 'failed';

        await tx.publications.update({
          where: { id: publicationId },
          data: {
            status: nextStatus,
            last_error: problemSummary,
          },
        });

        await settleOpportunity(tx, loadedPost.opportunityId, at, deps.jobId);
        return {
          refused: true as const,
          status: nextStatus as PublicationStatus,
          error: problemSummary,
        };
      }

      // Mark claimed and transition to publishing
      attemptCount = row.attempt_count + 1;
      await tx.publications.update({
        where: { id: publicationId },
        data: {
          status: 'publishing',
          claimed_at: at,
          attempt_count: attemptCount,
        },
      });

      const opp = await tx.post_opportunities.findUnique({
        where: { id: loadedPost.opportunityId },
      });
      if (opp && ['approved', 'scheduled'].includes(opp.status)) {
        await actingAs(tx, 'system:publisher', `publishing ${loadedPost.channel}`, deps.jobId);
        await tx.post_opportunities.update({
          where: { id: loadedPost.opportunityId },
          data: { status: 'publishing' },
        });
      }

      post = loadedPost;
      return { success: true as const };
    },
    { timeout: 60_000 },
  );

  if ('skipped' in claimResult) {
    return {
      publicationId,
      status:
        (claimResult.skipped === 'locked'
          ? 'pending'
          : (claimResult.skipped as PublicationStatus)) ?? 'pending',
      skipped: claimResult.skipped,
      mode: publishMode,
      channel: publicationChannel,
    };
  }

  if ('refused' in claimResult) {
    return {
      publicationId,
      status: claimResult.status ?? 'failed',
      outcome: 'refused',
      error: claimResult.error,
      mode: publishMode,
      channel: publicationChannel,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Step 2: Call channel (outside transaction)
  // -----------------------------------------------------------------------------------------------
  const publisher = publisherFor(post!.mode, post!.channel, deps.publishers);
  let publishResult: PublishResult | undefined;
  let publishError: PublishError | Error | undefined;
  const startedAt = at;

  try {
    publishResult = await publisher.publish(post!);
  } catch (err: unknown) {
    publishError = err as PublishError | Error;
  }
  const finishedAt = deps.now ? deps.now() : new Date();

  // -----------------------------------------------------------------------------------------------
  // Transaction 2: Record result
  // -----------------------------------------------------------------------------------------------
  return deps.db.$transaction(
    async (tx) => {
      // Lock row
      await tx.publications.findUniqueOrThrow({
        where: { id: publicationId },
      });

      const postConfig = await tx.post_configs.findFirst({
        where: { post_type_id: post!.postTypeId, is_active: true },
      });
      const configJson = (postConfig?.config_json as Record<string, any>) ?? {};
      const retryPolicy = configJson.retryPolicy ?? {};

      const maxAttempt = await tx.publication_attempts.aggregate({
        where: { publication_id: publicationId },
        _max: { attempt_no: true },
      });
      const attemptNo = (maxAttempt._max.attempt_no ?? 0) + 1;

      // Safe request summary (never containing credentials or headers)
      const requestSummary: Record<string, unknown> = {
        channel: post!.channel,
        mode: post!.mode,
        text: post!.text,
        length: post!.text.length,
        mediaHashes: post!.media.map((m) => m.sha256),
      };

      if (publishResult) {
        const next = nextState(
          { attempt_count: attemptCount, mode: post!.mode },
          publishResult,
          retryPolicy,
          finishedAt,
        );

        if (publishResult.kind === 'published') {
          await tx.publications.update({
            where: { id: publicationId },
            data: {
              status: 'published',
              external_id: publishResult.externalId,
              url: publishResult.url,
              published_at: publishResult.publishedAt,
              last_error: null,
            },
          });

          await tx.publication_attempts.create({
            data: {
              publication_id: publicationId,
              attempt_no: attemptNo,
              kind: 'send',
              outcome: next.outcome,
              request_summary: requestSummary as Prisma.InputJsonValue,
              response_summary: publishResult.response as Prisma.InputJsonValue,
              job_id: deps.jobId ?? null,
              started_at: startedAt,
              finished_at: finishedAt,
            },
          });

          await tx.audit_log.create({
            data: {
              actor: 'system:publisher',
              action: 'publication.published',
              target_type: 'publication',
              target_id: publicationId,
              details: {
                channel: post!.channel,
                mode: post!.mode,
                url: publishResult.url,
                approvalId: post!.approvalId,
              },
            },
          });

          await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);
          return {
            publicationId,
            channel: post!.channel,
            mode: post!.mode,
            status: 'published',
            outcome: next.outcome,
            externalId: publishResult.externalId,
            url: publishResult.url,
          };
        }

        // Dry run recorded
        await tx.publications.update({
          where: { id: publicationId },
          data: {
            status: 'dry_run_recorded',
            last_error: null,
          },
        });

        await tx.publication_attempts.create({
          data: {
            publication_id: publicationId,
            attempt_no: attemptNo,
            kind: 'send',
            outcome: 'dry_run',
            request_summary: publishResult.request as Prisma.InputJsonValue,
            response_summary: {},
            job_id: deps.jobId ?? null,
            started_at: startedAt,
            finished_at: finishedAt,
          },
        });

        await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);
        return {
          publicationId,
          channel: post!.channel,
          mode: post!.mode,
          status: 'dry_run_recorded',
          outcome: 'dry_run',
        };
      }

      // Handle PublishError or unexpected exception
      const errorObj = publishError!;
      const next = nextState(
        { attempt_count: attemptCount, mode: post!.mode },
        errorObj,
        retryPolicy,
        finishedAt,
      );

      const updateData: Prisma.publicationsUpdateInput = {
        status: next.nextStatus,
        retry_after: next.retryAfter,
        last_error: errorObj.message,
      };

      if (next.attemptDelta < 0) {
        updateData.attempt_count = { decrement: Math.abs(next.attemptDelta) };
      }

      await tx.publications.update({
        where: { id: publicationId },
        data: updateData,
      });

      await tx.publication_attempts.create({
        data: {
          publication_id: publicationId,
          attempt_no: attemptNo,
          kind: 'send',
          outcome: next.outcome,
          request_summary: requestSummary as Prisma.InputJsonValue,
          response_summary: (errorObj instanceof PublishError && errorObj.details
            ? errorObj.details
            : { code: (errorObj as any).code }) as Prisma.InputJsonValue,
          error: errorObj.message,
          job_id: deps.jobId ?? null,
          started_at: startedAt,
          finished_at: finishedAt,
        },
      });

      await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);

      return {
        publicationId,
        channel: post!.channel,
        mode: post!.mode,
        status: next.nextStatus,
        outcome: next.outcome,
        error: errorObj.message,
      };
    },
    { timeout: 60_000 },
  );
}

/** Reconciles an uncertain publication against channel timeline before retry. */
export async function reconcilePublication(
  deps: PublishDeps,
  publicationId: string,
): Promise<PublicationOutcome> {
  const at = deps.now ? deps.now() : new Date();

  let post: ApprovedPost;
  let since: Date = at;

  const check = await deps.db.$transaction(async (tx) => {
    const row = await tx.publications.findUnique({
      where: { id: publicationId },
      include: { review_actions: true },
    });
    if (!row) return { skipped: 'not_found' as const };

    // Stale publishing recovery
    const timeoutMs = 15_000;
    const staleCutoff = new Date(at.getTime() - (2 * timeoutMs + 60_000));
    if (row.status === 'publishing') {
      if (row.claimed_at && row.claimed_at < staleCutoff) {
        await tx.publications.update({
          where: { id: publicationId },
          data: {
            status: 'uncertain',
            last_error: 'interrupted',
            retry_after: at,
          },
        });
      } else {
        return { skipped: 'in_flight' as const };
      }
    } else if (row.status !== 'uncertain') {
      return { skipped: row.status as PublicationStatus };
    }

    if (row.retry_after && row.retry_after > at) {
      return { skipped: 'not_due' as const };
    }

    since = row.claimed_at ?? row.created_at;
    post = await loadApprovedPost(
      { db: tx as any, store: deps.store, channels: deps.channels },
      publicationId,
    );
    return { success: true as const };
  });

  if ('skipped' in check) {
    return {
      publicationId,
      status: (check.skipped === 'in_flight' ? 'publishing' : check.skipped) as PublicationStatus,
      skipped: check.skipped,
    };
  }

  // Lookup outside transaction
  const publisher = publisherFor(post!.mode, post!.channel, deps.publishers);
  const lookupResult = await publisher.lookup(post!, since);
  const finishedAt = deps.now ? deps.now() : new Date();

  // Record lookup attempt
  return deps.db.$transaction(async (tx) => {
    const row = await tx.publications.findUniqueOrThrow({
      where: { id: publicationId },
    });

    const maxAttempt = await tx.publication_attempts.aggregate({
      where: { publication_id: publicationId },
      _max: { attempt_no: true },
    });
    const attemptNo = (maxAttempt._max.attempt_no ?? 0) + 1;
    const newLookupCount = row.lookup_count + 1;

    const postConfig = await tx.post_configs.findFirst({
      where: { post_type_id: post!.postTypeId, is_active: true },
    });
    const retryPolicy = (postConfig?.config_json as any)?.retryPolicy ?? {};
    const maxAttempts = retryPolicy.maxAttempts ?? 3;

    if (lookupResult.kind === 'found') {
      await tx.publications.update({
        where: { id: publicationId },
        data: {
          status: 'published',
          external_id: lookupResult.externalId,
          url: lookupResult.url,
          published_at: lookupResult.publishedAt,
          lookup_count: newLookupCount,
          last_error: null,
          retry_after: null,
        },
      });

      await tx.publication_attempts.create({
        data: {
          publication_id: publicationId,
          attempt_no: attemptNo,
          kind: 'lookup',
          outcome: 'lookup_found',
          response_summary: {
            externalId: lookupResult.externalId,
            url: lookupResult.url,
          },
          job_id: deps.jobId ?? null,
          started_at: at,
          finished_at: finishedAt,
        },
      });

      await tx.audit_log.create({
        data: {
          actor: 'system:publisher',
          action: 'publication.reconciled',
          target_type: 'publication',
          target_id: publicationId,
          details: {
            externalId: lookupResult.externalId,
            url: lookupResult.url,
          },
        },
      });

      await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);
      return {
        publicationId,
        channel: post!.channel,
        mode: post!.mode,
        status: 'published',
        outcome: 'lookup_found',
        externalId: lookupResult.externalId,
        url: lookupResult.url,
      };
    }

    if (lookupResult.kind === 'absent') {
      const nextStatus = row.attempt_count >= maxAttempts ? 'failed' : 'pending';
      await tx.publications.update({
        where: { id: publicationId },
        data: {
          status: nextStatus,
          lookup_count: newLookupCount,
          retry_after: at,
          last_error: nextStatus === 'failed' ? 'max_attempts_exceeded' : null,
        },
      });

      await tx.publication_attempts.create({
        data: {
          publication_id: publicationId,
          attempt_no: attemptNo,
          kind: 'lookup',
          outcome: 'lookup_absent',
          job_id: deps.jobId ?? null,
          started_at: at,
          finished_at: finishedAt,
        },
      });

      await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);
      return {
        publicationId,
        channel: post!.channel,
        mode: post!.mode,
        status: nextStatus,
        outcome: 'lookup_absent',
      };
    }

    // Lookup failed (unknown)
    const maxLookups = deps.env.X_RECONCILE_MAX_LOOKUPS ?? 5;
    const baseDelay = deps.env.X_RECONCILE_DELAY_SECONDS ?? 60;

    let nextRetryAfter: Date | null = null;
    let nextLastError = lookupResult.reason;

    if (newLookupCount >= maxLookups) {
      nextRetryAfter = null;
      nextLastError = 'needs_manual_resolution';
      deps.logger.warn(
        { publicationId, lookupCount: newLookupCount },
        'Uncertain publication reached maximum lookup attempts and requires manual resolution',
      );
    } else {
      const delaySeconds = baseDelay * Math.pow(2, newLookupCount);
      nextRetryAfter = new Date(at.getTime() + delaySeconds * 1000);
    }

    await tx.publications.update({
      where: { id: publicationId },
      data: {
        status: 'uncertain',
        lookup_count: newLookupCount,
        retry_after: nextRetryAfter,
        last_error: nextLastError,
      },
    });

    await tx.publication_attempts.create({
      data: {
        publication_id: publicationId,
        attempt_no: attemptNo,
        kind: 'lookup',
        outcome: 'lookup_failed',
        error: lookupResult.reason,
        job_id: deps.jobId ?? null,
        started_at: at,
        finished_at: finishedAt,
      },
    });

    await settleOpportunity(tx, post!.opportunityId, finishedAt, deps.jobId);
    return {
      publicationId,
      channel: post!.channel,
      mode: post!.mode,
      status: 'uncertain',
      outcome: 'lookup_failed',
      error: lookupResult.reason,
    };
  });
}

/** Finds and processes due publications one by one. */
export async function publishDue(
  deps: PublishDeps,
  opts?: { limit?: number },
): Promise<PublicationOutcome[]> {
  const at = deps.now ? deps.now() : new Date();
  const limit = opts?.limit ?? 10;
  const outcomes: PublicationOutcome[] = [];

  // Step 1: Backfill missing publications for active approvals
  const activeOpportunities = await deps.db.post_opportunities.findMany({
    where: { status: { in: ['approved', 'scheduled'] } },
    include: {
      review_actions: {
        where: { action: 'approve' },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  for (const opp of activeOpportunities) {
    const approval = opp.review_actions[0];
    if (approval) {
      await ensurePublications(deps.db, approval.id, deps.env.SMB_PUBLISH_MODE);
    }
  }

  // Step 2: Handle stale publishing rows
  const timeoutMs = 15_000;
  const staleCutoff = new Date(at.getTime() - (2 * timeoutMs + 60_000));
  const stalePublishing = await deps.db.publications.findMany({
    where: {
      status: 'publishing',
      claimed_at: { lt: staleCutoff },
    },
    take: limit,
  });

  for (const row of stalePublishing) {
    try {
      const outcome = await reconcilePublication(deps, row.id);
      outcomes.push(outcome);
    } catch (err: unknown) {
      deps.logger.error(
        { err, publicationId: row.id },
        'Error reconciling stale publishing publication',
      );
    }
  }

  // Step 3: Reconcile uncertain rows whose retry_after is due
  const uncertainDue = await deps.db.publications.findMany({
    where: {
      status: 'uncertain',
      retry_after: { lte: at },
    },
    take: limit,
  });

  for (const row of uncertainDue) {
    try {
      const outcome = await reconcilePublication(deps, row.id);
      outcomes.push(outcome);
    } catch (err: unknown) {
      deps.logger.error({ err, publicationId: row.id }, 'Error reconciling uncertain publication');
    }
  }

  // Step 4: Process pending rows that are due
  const pendingDue = await deps.db.publications.findMany({
    where: {
      status: 'pending',
      AND: [
        { OR: [{ scheduled_for: null }, { scheduled_for: { lte: at } }] },
        { OR: [{ retry_after: null }, { retry_after: { lte: at } }] },
        {
          review_actions: {
            post_opportunities: {
              status: { in: ['approved', 'scheduled', 'publishing'] },
            },
          },
        },
      ],
    },
    orderBy: [{ scheduled_for: { sort: 'asc', nulls: 'first' } }, { created_at: 'asc' }],
    take: limit,
  });

  for (const row of pendingDue) {
    try {
      const outcome = await publishPublication(deps, row.id);
      outcomes.push(outcome);
    } catch (err: unknown) {
      deps.logger.error({ err, publicationId: row.id }, 'Error publishing due publication');
    }
  }

  return outcomes;
}
