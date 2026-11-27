import type { PrismaClient } from '@prisma/client';

/**
 * Operational KPIs (module 1.19): how much work was started, finished and lost, and how long it took. Counts
 * for a period come from the records that already exist (opportunities, jobs, publications, the trigger log);
 * nothing is stored twice.
 */

export interface OperationsPeriod {
  from: Date;
  to: Date;
}

export interface PipelineCounts {
  postType: string | null;
  /** Opportunities opened in the period, whatever started them. */
  opened: number;
  /** Of those, started by a schedule rule. */
  scheduled: number;
  /** Had candidates written. */
  generated: number;
  reachedReview: number;
  approved: number;
  rejected: number;
  published: number;
  failed: number;
}

export interface JobKindStats {
  kind: string;
  lane: string;
  total: number;
  succeeded: number;
  failed: number;
  dead: number;
  cancelled: number;
  /** Succeeded after more than one attempt. */
  retried: number;
  /** Failed or dead per finished job. Null until one has finished. */
  failureRate: number | null;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface PublicationStats {
  mode: string;
  channel: string;
  published: number;
  failed: number;
  uncertain: number;
  pending: number;
  dryRunRecorded: number;
  cancelled: number;
  /** published / (published + failed + uncertain). Dry runs never count towards it. */
  successRate: number | null;
}

export interface OperationsReport {
  period: { from: string; to: string };
  pipeline: PipelineCounts[];
  jobs: JobKindStats[];
  failureCodes: { code: string; kind: string; count: number }[];
  reviewQueue: { waiting: number; oldestWaitingSince: string | null };
  jobQueue: { lane: string; queued: number; oldestQueuedSince: string | null }[];
  /** Opportunity created to first ready for review. */
  timeToReview: { posts: number; medianSeconds: number | null; p90Seconds: number | null };
  publications: PublicationStats[];
  /** Triggers that were recognised as already handled (a duplicate) or refused, from the trigger log. */
  duplicates: { outcome: string; count: number }[];
}

const ratio = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 1000 : null;
const round = (n: number | null): number | null => (n === null ? null : Math.round(n));

export async function operationsReport(
  db: PrismaClient,
  p: OperationsPeriod,
): Promise<OperationsReport> {
  const pipeline = await db.$queryRaw<
    {
      post_type_id: string | null;
      opened: number;
      scheduled: number;
      generated: number;
      reached_review: number;
      approved: number;
      rejected: number;
      published: number;
      failed: number;
    }[]
  >`
    select
      o.post_type_id,
      count(*)::int                                                   as opened,
      count(*) filter (where o.trigger_kind = 'schedule')::int        as scheduled,
      count(*) filter (where exists (
        select 1 from smb.post_candidates c where c.opportunity_id = o.id))::int as generated,
      count(*) filter (where exists (
        select 1 from smb.opportunity_events e
        where e.opportunity_id = o.id and e.to_status = 'awaiting_review'))::int as reached_review,
      count(*) filter (where o.status in ('approved', 'scheduled', 'publishing', 'published', 'partially_published'))::int
                                                                      as approved,
      count(*) filter (where o.status = 'rejected')::int              as rejected,
      count(*) filter (where o.status in ('published', 'partially_published'))::int as published,
      count(*) filter (where o.status = 'failed')::int                as failed
    from smb.post_opportunities o
    where o.created_at >= ${p.from}::timestamptz and o.created_at < ${p.to}::timestamptz
    group by rollup (o.post_type_id)
    order by o.post_type_id nulls first`;

  const jobRows = await db.$queryRaw<
    {
      kind: string;
      lane: string;
      total: number;
      succeeded: number;
      failed: number;
      dead: number;
      cancelled: number;
      retried: number;
      p50: number | null;
      p90: number | null;
    }[]
  >`
    select
      j.kind, j.lane::text as lane,
      count(*)::int                                                   as total,
      count(*) filter (where j.status = 'succeeded')::int             as succeeded,
      count(*) filter (where j.status = 'failed')::int                as failed,
      count(*) filter (where j.status = 'dead')::int                  as dead,
      count(*) filter (where j.status in ('cancelled', 'expired'))::int as cancelled,
      count(*) filter (where j.status = 'succeeded' and j.attempts > 1)::int as retried,
      (percentile_cont(0.5) within group (order by j.duration_ms)
        filter (where j.status = 'succeeded' and j.duration_ms > 0) / 1000.0)::float8 as p50,
      (percentile_cont(0.9) within group (order by j.duration_ms)
        filter (where j.status = 'succeeded' and j.duration_ms > 0) / 1000.0)::float8 as p90
    from smb.jobs j
    where j.created_at >= ${p.from}::timestamptz and j.created_at < ${p.to}::timestamptz
    group by j.kind, j.lane
    order by j.kind`;

  const failureCodes = await db.$queryRaw<{ code: string; kind: string; count: number }[]>`
    select coalesce(j.error_code, 'unknown') as code, j.kind, count(*)::int as count
    from smb.jobs j
    where j.status in ('failed', 'dead')
      and j.created_at >= ${p.from}::timestamptz and j.created_at < ${p.to}::timestamptz
    group by 1, 2
    order by count(*) desc, 1
    limit 20`;

  const [queue] = await db.$queryRaw<{ waiting: number; oldest: Date | null }[]>`
    select count(*)::int as waiting, min(w.at) as oldest
    from smb.post_opportunities o
    cross join lateral (
      select max(e.created_at) as at from smb.opportunity_events e
      where e.opportunity_id = o.id and e.to_status = 'awaiting_review'
    ) w
    where o.status = 'awaiting_review'`;

  const jobQueue = await db.$queryRaw<{ lane: string; queued: number; oldest: Date | null }[]>`
    select j.lane::text as lane, count(*)::int as queued, min(j.run_after) as oldest
    from smb.jobs j where j.status = 'queued' group by j.lane order by j.lane`;

  const [ttr] = await db.$queryRaw<{ n: number; p50: number | null; p90: number | null }[]>`
    with first_ready as (
      select o.id, o.created_at, min(e.created_at) as ready_at
      from smb.post_opportunities o
      join smb.opportunity_events e on e.opportunity_id = o.id and e.to_status = 'awaiting_review'
      where o.created_at >= ${p.from}::timestamptz and o.created_at < ${p.to}::timestamptz
      group by o.id, o.created_at
    )
    select count(*)::int as n,
      percentile_cont(0.5) within group (order by extract(epoch from ready_at - created_at))::float8 as p50,
      percentile_cont(0.9) within group (order by extract(epoch from ready_at - created_at))::float8 as p90
    from first_ready`;

  const pubRows = await db.$queryRaw<
    { mode: string; channel: string; status: string; count: number }[]
  >`
    select pb.mode::text as mode, pb.channel::text as channel, pb.status::text as status, count(*)::int as count
    from smb.publications pb
    where pb.created_at >= ${p.from}::timestamptz and pb.created_at < ${p.to}::timestamptz
    group by 1, 2, 3`;

  const duplicates = await db.$queryRaw<{ outcome: string; count: number }[]>`
    select t.outcome, count(*)::int as count
    from smb.trigger_log t
    where t.outcome in ('duplicate', 'refused')
      and t.at >= ${p.from}::timestamptz and t.at < ${p.to}::timestamptz
    group by 1 order by 1`;

  const keys = [...new Set(pubRows.map((r) => `${r.mode}|${r.channel}`))].sort();
  const publications = keys.map((k): PublicationStats => {
    const [mode, channel] = k.split('|') as [string, string];
    const n = (status: string): number =>
      pubRows.find((r) => r.mode === mode && r.channel === channel && r.status === status)?.count ??
      0;
    const published = n('published');
    const failed = n('failed');
    const uncertain = n('uncertain');
    return {
      mode,
      channel,
      published,
      failed,
      uncertain,
      pending: n('pending') + n('publishing'),
      dryRunRecorded: n('dry_run_recorded'),
      cancelled: n('cancelled'),
      successRate: mode === 'dry_run' ? null : ratio(published, published + failed + uncertain),
    };
  });

  return {
    period: { from: p.from.toISOString(), to: p.to.toISOString() },
    pipeline: pipeline.map((r) => ({
      postType: r.post_type_id,
      opened: r.opened,
      scheduled: r.scheduled,
      generated: r.generated,
      reachedReview: r.reached_review,
      approved: r.approved,
      rejected: r.rejected,
      published: r.published,
      failed: r.failed,
    })),
    jobs: jobRows.map((r) => ({
      kind: r.kind,
      lane: r.lane,
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      dead: r.dead,
      cancelled: r.cancelled,
      retried: r.retried,
      failureRate: ratio(r.failed + r.dead, r.succeeded + r.failed + r.dead),
      medianSeconds: round(r.p50),
      p90Seconds: round(r.p90),
    })),
    failureCodes,
    reviewQueue: {
      waiting: queue?.waiting ?? 0,
      oldestWaitingSince: queue?.oldest?.toISOString() ?? null,
    },
    jobQueue: jobQueue.map((r) => ({
      lane: r.lane,
      queued: r.queued,
      oldestQueuedSince: r.oldest?.toISOString() ?? null,
    })),
    timeToReview: { posts: ttr?.n ?? 0, medianSeconds: round(ttr?.p50 ?? null), p90Seconds: round(ttr?.p90 ?? null) },
    publications,
    duplicates,
  };
}
