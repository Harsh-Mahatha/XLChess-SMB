import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ConfigError,
  PostTypeConfig,
  ResearchSubject,
  isoWeekLabel,
  localParts,
  renderDedupeKey,
  resolvePhase,
  scheduleSlotLabel,
  type EventTrigger,
} from '@smb/shared';
import type { ContextResolvers } from './context.js';
import { defaultResolver } from './context.js';
import { writeTriggerLog } from './log.js';
import type { OpenResult, OpportunityContext, TriggerRequest } from './types.js';

export async function openOpportunityIn(
  tx: Prisma.TransactionClient,
  req: TriggerRequest,
  now: Date,
): Promise<OpenResult> {
  // 1. Load post_types and active post_configs row
  const postType = await tx.post_types.findUnique({ where: { id: req.postTypeId } });
  if (!postType) {
    await writeTriggerLog(tx, {
      postTypeId: req.postTypeId,
      triggerKind: req.kind,
      outcome: 'refused',
      reason: `Unknown post type: ${req.postTypeId}`,
      ruleKey: req.kind === 'schedule' ? req.ruleKey : null,
    });
    return {
      status: 'refused',
      code: 'unknown_post_type',
      message: `Unknown post type: ${req.postTypeId}`,
    };
  }

  const activeConfigRow = await tx.post_configs.findFirst({
    where: { post_type_id: req.postTypeId, is_active: true },
  });
  if (!activeConfigRow) {
    await writeTriggerLog(tx, {
      postTypeId: req.postTypeId,
      triggerKind: req.kind,
      outcome: 'refused',
      reason: `No active configuration for post type: ${req.postTypeId}`,
      ruleKey: req.kind === 'schedule' ? req.ruleKey : null,
    });
    return {
      status: 'refused',
      code: 'no_active_config',
      message: `No active configuration for post type: ${req.postTypeId}`,
    };
  }

  const config = PostTypeConfig.parse(activeConfigRow.config_json);

  // Check disabled status (D10)
  if (!postType.enabled || !config.enabled) {
    await writeTriggerLog(tx, {
      postTypeId: req.postTypeId,
      triggerKind: req.kind,
      outcome: 'refused',
      reason: `Post type ${req.postTypeId} is disabled`,
      ruleKey: req.kind === 'schedule' ? req.ruleKey : null,
    });
    return {
      status: 'refused',
      code: 'post_type_disabled',
      message: `Post type ${req.postTypeId} is disabled`,
    };
  }

  // 2. Resolve phase (unknown phase throws ConfigError -> refuse unknown_phase)
  let effective;
  try {
    effective = resolvePhase(config, req.context.phase);
  } catch (err) {
    if (err instanceof ConfigError) {
      await writeTriggerLog(tx, {
        postTypeId: req.postTypeId,
        triggerKind: req.kind,
        outcome: 'refused',
        reason: `Unknown phase: ${req.context.phase}`,
        ruleKey: req.kind === 'schedule' ? req.ruleKey : null,
      });
      return {
        status: 'refused',
        code: 'unknown_phase',
        message: `Unknown phase: ${req.context.phase}`,
      };
    }
    throw err;
  }

  // 3. Event triggers only: effective schedule must contain matching event rule (D12)
  if (req.kind === 'event') {
    const hasEventRule = effective.schedule.some(
      (r) => r.kind === 'event' && r.event === req.event,
    );
    if (!hasEventRule) {
      await writeTriggerLog(tx, {
        postTypeId: req.postTypeId,
        triggerKind: req.kind,
        outcome: 'refused',
        reason: `Event "${req.event}" not configured in phase "${req.context.phase ?? 'base'}" for ${req.postTypeId}`,
        detail: { event: req.event, phase: req.context.phase },
      });
      return {
        status: 'refused',
        code: 'trigger_not_configured',
        message: `Event "${req.event}" is not configured in phase "${req.context.phase ?? 'base'}"`,
      };
    }
  }

  // 4. Render dedupe key and calculate timing & priority (D13, D14, D16)
  let dedupeKey: string;
  let scheduledFor: Date;
  let notAfter: Date | null;
  const priority = effective.priority;

  if (req.kind === 'manual') {
    dedupeKey = `manual:${req.postTypeId}:${req.requestId}`;
    scheduledFor = req.scheduledFor ?? now;
    notAfter = req.notAfter ?? null;
  } else if (req.kind === 'schedule') {
    const slotStr = scheduleSlotLabel(req.slotAt);
    const lp = localParts(req.slotAt.getTime(), config.timezone);
    const dateStr = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;
    const weekStr = isoWeekLabel(lp);

    dedupeKey = renderDedupeKey(config.deduplication.keyTemplate, {
      postType: config.id,
      eventId: req.context.eventKey,
      slot: slotStr,
      date: dateStr,
      week: weekStr,
    });
    scheduledFor = req.slotAt;
    notAfter = new Date(req.slotAt.getTime() + effective.staleAfterMinutes * 60_000);
  } else {
    // event
    const lp = localParts(req.occurredAt.getTime(), config.timezone);
    const dateStr = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;
    const weekStr = isoWeekLabel(lp);

    dedupeKey = renderDedupeKey(config.deduplication.keyTemplate, {
      postType: config.id,
      eventId: req.context.eventKey,
      slot: req.slot,
      date: dateStr,
      week: weekStr,
    });
    scheduledFor = req.occurredAt;
    notAfter = new Date(req.occurredAt.getTime() + effective.staleAfterMinutes * 60_000);
  }

  // Validate research subject (D15)
  const subject = ResearchSubject.parse(req.context.subject);

  // 5. Determine actor and reason, set session variables
  const actor =
    req.kind === 'schedule'
      ? 'scheduler'
      : req.kind === 'event'
        ? (req.actor ?? `event:${req.event}`)
        : req.requestedBy;
  const triggeredBy = actor;

  await tx.$executeRaw`select set_config('smb.actor', ${actor}, true), set_config('smb.reason', ${req.reason}, true), set_config('smb.job_id', '', true)`;

  // 6. Insert opportunity with on conflict (dedupe_key) do nothing
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    insert into smb.post_opportunities (
      post_type_id,
      post_config_id,
      dedupe_key,
      trigger_kind,
      trigger_ref,
      trigger_reason,
      triggered_by,
      phase,
      priority,
      scheduled_for,
      not_after
    ) values (
      ${req.postTypeId},
      ${activeConfigRow.id}::uuid,
      ${dedupeKey},
      ${req.kind},
      ${JSON.stringify(subject)}::jsonb,
      ${req.reason},
      ${triggeredBy},
      ${req.context.phase},
      ${priority},
      ${scheduledFor},
      ${notAfter}
    )
    on conflict (dedupe_key) do nothing
    returning id
  `;

  let opportunityId: string;
  let outcome: 'created' | 'duplicate';

  if (inserted.length > 0 && inserted[0]) {
    opportunityId = inserted[0].id;
    outcome = 'created';
  } else {
    const existing = await tx.post_opportunities.findUnique({
      where: { dedupe_key: dedupeKey },
      select: { id: true },
    });
    opportunityId = existing!.id;
    outcome = 'duplicate';
  }

  // 7. Write immutable trigger_log row
  await writeTriggerLog(tx, {
    postTypeId: req.postTypeId,
    triggerKind: req.kind,
    outcome,
    ruleKey: req.kind === 'schedule' ? req.ruleKey : null,
    slotAt: req.kind === 'schedule' ? req.slotAt : req.kind === 'event' ? req.occurredAt : null,
    dedupeKey,
    opportunityId,
    reason: req.reason,
    detail: {
      phase: req.context.phase,
      priority,
      scheduledFor: scheduledFor.toISOString(),
      notAfter: notAfter ? notAfter.toISOString() : null,
    },
  });

  if (outcome === 'created') {
    return { status: 'created', opportunityId, dedupeKey };
  }
  return { status: 'duplicate', opportunityId, dedupeKey };
}

/** Opens its own transaction and takes the per-post-type advisory lock `smb.sched:<postTypeId>`. */
export async function openOpportunity(
  deps: { db: PrismaClient; now?: Date },
  req: TriggerRequest,
): Promise<OpenResult> {
  const now = deps.now ?? new Date();
  return deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.sched:' + req.postTypeId}))`;
    return openOpportunityIn(tx, req, now);
  });
}

export interface OpenEventArgs {
  postTypeId: string;
  event: EventTrigger;
  occurredAt?: Date;
  slot: string;
  context: OpportunityContext;
  reason: string;
  actor?: string;
}

export async function openEventOpportunity(
  deps: { db: PrismaClient; now?: Date },
  args: OpenEventArgs,
): Promise<OpenResult> {
  const now = deps.now ?? new Date();
  return openOpportunity(deps, {
    kind: 'event',
    postTypeId: args.postTypeId,
    event: args.event,
    occurredAt: args.occurredAt ?? now,
    slot: args.slot,
    context: args.context,
    reason: args.reason,
    actor: args.actor,
  });
}

export interface OpenManualArgs {
  postTypeId: string;
  requestedBy: string;
  requestId: string;
  reason: string;
  phase?: string;
  subject?: ResearchSubject;
  scheduledFor?: Date;
  notAfter?: Date;
}

export async function openManualOpportunity(
  deps: { db: PrismaClient; resolvers?: ContextResolvers; now?: Date },
  args: OpenManualArgs,
): Promise<OpenResult> {
  const now = deps.now ?? new Date();
  let context: OpportunityContext;

  if (args.phase !== undefined && args.subject !== undefined) {
    const slug = args.postTypeId.replace(/\./g, '-');
    context = {
      phase: args.phase,
      subject: args.subject,
      eventKey: `pt${slug}`,
    };
  } else {
    const activeConfigRow = await deps.db.post_configs.findFirst({
      where: { post_type_id: args.postTypeId, is_active: true },
    });
    if (!activeConfigRow) {
      return {
        status: 'refused',
        code: 'no_active_config',
        message: `No active configuration for post type: ${args.postTypeId}`,
      };
    }
    const config = PostTypeConfig.parse(activeConfigRow.config_json);
    const resolver = deps.resolvers?.for(args.postTypeId) ?? defaultResolver;
    const res = await resolver.resolve({
      postTypeId: args.postTypeId,
      config,
      trigger: 'manual',
      now,
      db: deps.db,
    });
    if (res.kind === 'hold') {
      return {
        status: 'refused',
        code: 'post_type_disabled',
        message: `Post type held for review: ${res.reason}`,
      };
    }
    context = {
      phase: args.phase !== undefined ? args.phase : res.context.phase,
      subject: args.subject !== undefined ? args.subject : res.context.subject,
      eventKey: res.context.eventKey,
    };
  }

  return openOpportunity(deps, {
    kind: 'manual',
    postTypeId: args.postTypeId,
    requestedBy: args.requestedBy,
    requestId: args.requestId,
    reason: args.reason,
    context,
    scheduledFor: args.scheduledFor,
    notAfter: args.notAfter,
  });
}
