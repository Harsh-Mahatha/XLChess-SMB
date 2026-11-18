import type { Prisma, PrismaClient } from '@prisma/client';
import {
  PostTypeConfig,
  isTimedRule,
  nextOccurrence,
  occurrencesBetween,
  resolvePhase,
  ruleKey,
  type TimedRule,
} from '@smb/shared';
import type { Logger } from 'pino';
import type { ContextResolvers } from './context.js';
import { writeTriggerLog } from './log.js';
import { openOpportunityIn } from './open.js';
import type { OpportunityContext, TickSummary } from './types.js';

export interface SchedulerDeps {
  db: PrismaClient;
  resolvers: ContextResolvers;
  logger: Logger;
}

export async function runSchedulerTick(
  deps: SchedulerDeps,
  opts: { now?: Date } = {},
): Promise<TickSummary> {
  const now = opts.now ?? new Date();
  const summary: TickSummary = {
    at: now.toISOString(),
    postTypes: 0,
    created: 0,
    duplicates: 0,
    missed: 0,
    inactive: 0,
    errors: 0,
  };

  const activeConfigs = await deps.db.post_configs.findMany({
    where: { is_active: true },
    include: { post_types: true },
  });

  summary.postTypes = activeConfigs.length;

  for (const configRow of activeConfigs) {
    const postTypeId = configRow.post_type_id;

    try {
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.sched:' + postTypeId}))`;

        // 1. Load config and post_types row under transaction
        const postType = await tx.post_types.findUniqueOrThrow({
          where: { id: postTypeId },
        });
        const config = PostTypeConfig.parse(configRow.config_json);

        // Expired holds: delete and write audit log
        const hold = await tx.schedule_holds.findUnique({
          where: { post_type_id: postTypeId },
        });

        let isSuspended = false;
        if (hold) {
          if (hold.suspended_until && hold.suspended_until.getTime() <= now.getTime()) {
            await tx.schedule_holds.delete({ where: { post_type_id: postTypeId } });
            await tx.audit_log.create({
              data: {
                actor: 'system',
                action: 'schedule.resume',
                target_type: 'post_type',
                target_id: postTypeId,
                details: {
                  reason: 'Hold expired',
                  expiredAt: hold.suspended_until.toISOString(),
                },
              },
            });
          } else {
            isSuspended = true;
          }
        }

        // Determine inactiveBase (D10, D9)
        let inactiveBase:
          | 'post_type_disabled'
          | 'config_disabled'
          | 'suspended'
          | 'held_for_review'
          | null = null;

        if (!postType.enabled) {
          inactiveBase = 'post_type_disabled';
        } else if (!config.enabled) {
          inactiveBase = 'config_disabled';
        } else if (isSuspended) {
          inactiveBase = 'suspended';
        }

        // 2. Resolve context (trigger: 'schedule')
        let context: OpportunityContext;
        let phase: string | null = null;

        if (!inactiveBase) {
          const resolver = deps.resolvers.for(postTypeId);
          const resolved = await resolver.resolve({
            postTypeId,
            config,
            trigger: 'schedule',
            now,
            db: tx,
          });

          if (resolved.kind === 'hold') {
            inactiveBase = 'held_for_review';
            context = {
              phase: null,
              subject: { eventRefs: {} },
              eventKey: `pt${postTypeId.replace(/\./g, '-')}`,
            };
          } else {
            context = resolved.context;
            phase = context.phase;
          }
        } else {
          context = {
            phase: null,
            subject: { eventRefs: {} },
            eventKey: `pt${postTypeId.replace(/\./g, '-')}`,
          };
        }

        // 3. Compute desired timed rules for phase, and allKeys across base + all phases
        const effective = resolvePhase(config, phase);
        const desiredTimedRules = effective.schedule.filter(isTimedRule);
        const desiredMap = new Map<string, { rule: TimedRule; key: string }>();

        for (const r of desiredTimedRules) {
          const key = ruleKey(r, phase, config.timezone);
          desiredMap.set(key, { rule: r, key });
        }

        const allKeys = new Set<string>();
        for (const r of config.schedule.filter(isTimedRule)) {
          allKeys.add(ruleKey(r, null, config.timezone));
        }
        for (const p of config.phases ?? []) {
          if (p.schedule) {
            for (const r of p.schedule.filter(isTimedRule)) {
              allKeys.add(ruleKey(r, p.id, config.timezone));
            }
          }
        }

        // 4. Load existing schedules rows
        const existingRows = await tx.schedules.findMany({
          where: { post_type_id: postTypeId },
        });
        const existingMap = new Map(existingRows.map((r) => [r.rule_key, r]));

        // Create missing desired rows (D7: anchor_at = cursor_at = now)
        for (const [key, { rule }] of desiredMap) {
          if (!existingMap.has(key)) {
            const nextRun = inactiveBase
              ? null
              : nextOccurrence(rule, config.timezone, now, now);
            const created = await tx.schedules.create({
              data: {
                post_type_id: postTypeId,
                rule_key: key,
                phase_id: phase,
                rule: rule as unknown as Prisma.InputJsonValue,
                timezone: config.timezone,
                anchor_at: now,
                cursor_at: now,
                next_run_at: nextRun,
                state: inactiveBase ? 'inactive' : 'active',
                inactive_reason: inactiveBase ?? null,
              },
            });
            existingMap.set(key, created);
            if (inactiveBase) {
              await writeTriggerLog(tx, {
                postTypeId,
                triggerKind: 'schedule',
                outcome: 'rule_inactive',
                ruleKey: key,
                reason: `Rule inactive: ${inactiveBase}`,
                detail: { inactiveReason: inactiveBase },
              });
            }
          }
        }

        // Existing rows not in desired: inactive/phase_inactive or retired
        for (const row of existingRows) {
          if (!desiredMap.has(row.rule_key)) {
            const isPhaseInactive = allKeys.has(row.rule_key);
            const targetState = isPhaseInactive ? 'inactive' : 'retired';
            const targetReason = isPhaseInactive ? 'phase_inactive' : null;

            if (row.state !== targetState || row.inactive_reason !== targetReason) {
              if (row.state === 'active') {
                await writeTriggerLog(tx, {
                  postTypeId,
                  triggerKind: 'schedule',
                  outcome: 'rule_inactive',
                  ruleKey: row.rule_key,
                  reason: `Rule inactive: ${targetReason ?? targetState}`,
                  detail: { state: targetState, inactiveReason: targetReason },
                });
              }
              await tx.schedules.update({
                where: { id: row.id },
                data: {
                  state: targetState,
                  inactive_reason: targetReason,
                  cursor_at: now,
                  next_run_at: null,
                },
              });
            } else {
              // Rule remains inactive; keep cursor moving forward (D6)
              await tx.schedules.update({
                where: { id: row.id },
                data: {
                  cursor_at: now,
                  next_run_at: null,
                },
              });
            }
          }
        }

        // 5. If inactiveBase is set, mark every desired row inactive with that reason, cursor_at = now
        if (inactiveBase) {
          summary.inactive += desiredMap.size;
          for (const [key] of desiredMap) {
            const row = existingMap.get(key)!;
            const changed = row.state !== 'inactive' || row.inactive_reason !== inactiveBase;

            if (changed) {
              await writeTriggerLog(tx, {
                postTypeId,
                triggerKind: 'schedule',
                outcome: 'rule_inactive',
                ruleKey: key,
                reason: `Rule inactive: ${inactiveBase}`,
                detail: { inactiveReason: inactiveBase },
              });
            }

            await tx.schedules.update({
              where: { id: row.id },
              data: {
                state: 'inactive',
                inactive_reason: inactiveBase,
                cursor_at: now,
                next_run_at: null,
              },
            });
          }
          return;
        }

        // 6. Active desired rows evaluation
        for (const [key, { rule }] of desiredMap) {
          const row = existingMap.get(key)!;

          if (row.state !== 'active') {
            await writeTriggerLog(tx, {
              postTypeId,
              triggerKind: 'schedule',
              outcome: 'rule_active',
              ruleKey: key,
              reason: `Rule active in phase ${phase ?? 'base'}`,
              detail: { phase },
            });
          }

          const slots = occurrencesBetween(
            rule,
            config.timezone,
            row.cursor_at,
            now,
            row.anchor_at,
          );

          if (slots.length === 0) {
            const nextRun = nextOccurrence(rule, config.timezone, now, row.anchor_at);
            await tx.schedules.update({
              where: { id: row.id },
              data: {
                cursor_at: now,
                next_run_at: nextRun,
                state: 'active',
                inactive_reason: null,
              },
            });
            continue;
          }

          const latest = slots[slots.length - 1]!;
          const earlier = slots.slice(0, -1);

          if (earlier.length > 0) {
            await writeTriggerLog(tx, {
              postTypeId,
              triggerKind: 'schedule',
              outcome: 'missed_coalesced',
              ruleKey: key,
              reason: `Coalesced ${earlier.length} missed slot(s) before latest slot ${latest.toISOString()}`,
              detail: {
                missedSlots: earlier.map((s) => s.toISOString()),
                latestSlot: latest.toISOString(),
              },
            });
            summary.missed += earlier.length;
          }

          const staleMs = effective.staleAfterMinutes * 60_000;
          const ageMs = now.getTime() - latest.getTime();

          let lastOutcome: string;
          let lastOpportunityId: string | null = null;

          if (ageMs > staleMs) {
            await writeTriggerLog(tx, {
              postTypeId,
              triggerKind: 'schedule',
              outcome: 'missed_expired',
              ruleKey: key,
              slotAt: latest,
              reason: `Missed slot ${latest.toISOString()} is older than stale window (${effective.staleAfterMinutes}m)`,
              detail: {
                slotAt: latest.toISOString(),
                staleAfterMinutes: effective.staleAfterMinutes,
                ageSeconds: Math.floor(ageMs / 1000),
              },
            });
            summary.missed++;
            lastOutcome = 'missed_expired';
          } else {
            let ruleDesc = '';
            if (rule.kind === 'weekly') {
              ruleDesc = `Weekly schedule "${rule.day} ${rule.time} ${config.timezone}"`;
            } else if (rule.kind === 'daily') {
              ruleDesc = `Daily schedule "${rule.time} ${config.timezone}"`;
            } else {
              ruleDesc = `Interval schedule "${rule.everyMinutes}m"`;
            }
            const reason = `${ruleDesc} (slot ${latest.toISOString()}), phase ${phase ?? 'base'}`;

            const openRes = await openOpportunityIn(
              tx,
              {
                kind: 'schedule',
                postTypeId,
                slotAt: latest,
                ruleKey: key,
                context,
                reason,
              },
              now,
            );

            if (openRes.status === 'created') {
              summary.created++;
              lastOutcome = 'created';
              lastOpportunityId = openRes.opportunityId;
            } else if (openRes.status === 'duplicate') {
              summary.duplicates++;
              lastOutcome = 'duplicate';
              lastOpportunityId = openRes.opportunityId;
            } else {
              lastOutcome = 'none';
            }
          }

          const nextRun = nextOccurrence(rule, config.timezone, now, row.anchor_at);
          await tx.schedules.update({
            where: { id: row.id },
            data: {
              cursor_at: now,
              next_run_at: nextRun,
              state: 'active',
              inactive_reason: null,
              last_slot_at: latest,
              last_opportunity_id: lastOpportunityId,
              last_outcome: lastOutcome,
            },
          });
        }
      });
    } catch (err) {
      deps.logger.error({ err, postTypeId }, 'Error during scheduler tick for post type');
      summary.errors++;
    }
  }

  return summary;
}
