import {
  FEED_OUTAGE_ALERT_HOURS,
  OVERDUE_CONCLUSION_HOURS,
  START_EARLY_TOLERANCE_HOURS,
  START_LATE_GRACE_HOURS,
  makeFlag,
  type ChampionshipPhase,
  type FlagDraft,
} from './flags.js';
import { clinched, uniqueWinner } from './score.js';

const HOUR_MS = 3_600_000;

export interface PhaseInput {
  now: Date;
  phase: ChampionshipPhase;
  locked: boolean;
  scheduledStart: Date;
  scheduledEnd: Date;
  feedStatus: 'upcoming' | 'in_progress' | 'completed' | null;
  feedOk: boolean;
  anyGameObserved: boolean;
  classical: {
    total: number;
    confirmed: number;
    observedFinal: number;
    unconfirmedNumbers?: number[];
  };
  score: { a: number; b: number };
  lastFeedOkAt: Date | null;
}

export interface PhaseDecision {
  next: ChampionshipPhase;
  reasons: string[];
  flags: FlagDraft[];
}

/**
 * Pure, deterministic phase-transition evaluator for PT 1.1.
 * Evaluated one step per call; the caller may loop at most twice when jumping pre -> tournament -> post.
 */
export function detectPhase(i: PhaseInput): PhaseDecision {
  const nowMs = i.now.getTime();
  const startMs = i.scheduledStart.getTime();
  const endMs = i.scheduledEnd.getTime();
  const reasons: string[] = [];
  const flags: FlagDraft[] = [];
  let wouldNext: ChampionshipPhase = i.phase;

  if (i.phase === 'pre_tournament') {
    const started =
      i.feedStatus === 'in_progress' || i.feedStatus === 'completed' || i.anyGameObserved;
    const withinStartWindow = nowMs >= startMs - START_EARLY_TOLERANCE_HOURS * HOUR_MS;

    if (started && withinStartWindow) {
      wouldNext = 'tournament';
      reasons.push(
        i.anyGameObserved
          ? 'At least one game has been observed within 24h of the scheduled start'
          : `Feed reports event status "${i.feedStatus}" within 24h of the scheduled start`,
      );
    } else if (started && !withinStartWindow) {
      reasons.push('Feed indicates the event started more than 24h before scheduled start');
      flags.push(
        makeFlag(
          'premature_start',
          `Feed reports "${i.feedStatus ?? 'game_observed'}" more than ${START_EARLY_TOLERANCE_HOURS}h before scheduled start (${i.scheduledStart.toISOString()})`,
          {
            detail: {
              feedStatus: i.feedStatus,
              anyGameObserved: i.anyGameObserved,
              scheduledStart: i.scheduledStart.toISOString(),
            },
          },
        ),
      );
    } else if (!started && i.feedOk && nowMs > startMs + START_LATE_GRACE_HOURS * HOUR_MS) {
      reasons.push('Event has not started more than 24h after scheduled start');
      flags.push(
        makeFlag(
          'late_start',
          `Event has not started more than ${START_LATE_GRACE_HOURS}h past scheduled start (${i.scheduledStart.toISOString()})`,
          {
            detail: {
              feedStatus: i.feedStatus,
              scheduledStart: i.scheduledStart.toISOString(),
            },
          },
        ),
      );
    }
  } else if (i.phase === 'tournament') {
    const allClassicalConfirmed = i.classical.confirmed >= i.classical.total;
    const winner = uniqueWinner(i.score);

    if (i.feedStatus === 'completed' && allClassicalConfirmed && winner !== null) {
      wouldNext = 'post_tournament';
      reasons.push(
        `Feed reports completed, all ${i.classical.total} classical games are confirmed, and player ${winner.toUpperCase()} leads (${i.score.a}-${i.score.b})`,
      );
    } else {
      if (i.feedStatus === 'completed' && !allClassicalConfirmed) {
        const missingCount = i.classical.total - i.classical.confirmed;
        reasons.push(
          `Feed reports completed, but ${missingCount} classical game(s) are unconfirmed`,
        );
        flags.push(
          makeFlag(
            'unconfirmed_games',
            `Feed reports event completed, but ${missingCount} of ${i.classical.total} classical games are not yet confirmed`,
            {
              detail: {
                confirmed: i.classical.confirmed,
                total: i.classical.total,
                ...(i.classical.unconfirmedNumbers !== undefined
                  ? { numbers: i.classical.unconfirmedNumbers }
                  : {}),
              },
            },
          ),
        );
      }

      const earlyClincher = clinched(i.score, i.classical.total);
      if (earlyClincher !== null && !allClassicalConfirmed) {
        reasons.push(
          `Player ${earlyClincher.toUpperCase()} has clinched (${i.score.a}-${i.score.b}) with classical games remaining; awaiting administrator conclusion`,
        );
        flags.push(
          makeFlag(
            'conclusion_unconfirmed',
            `Player ${earlyClincher.toUpperCase()} has clinched the match (${i.score.a}-${i.score.b}); administrator must confirm conclusion`,
            {
              detail: {
                clinchedBy: earlyClincher,
                score: i.score,
                confirmed: i.classical.confirmed,
                total: i.classical.total,
              },
            },
          ),
        );
      }

      if (allClassicalConfirmed && winner === null) {
        reasons.push(
          `All ${i.classical.total} classical games are confirmed with a tied score (${i.score.a}-${i.score.b}); awaiting tiebreaks or administrator conclusion`,
        );
        flags.push(
          makeFlag(
            'no_unique_winner',
            `All ${i.classical.total} classical games are confirmed but the match is tied (${i.score.a}-${i.score.b})`,
            { detail: { score: i.score } },
          ),
        );
      }

      if (i.feedStatus === 'upcoming' && i.feedOk) {
        reasons.push('Feed regressed to "upcoming" during tournament');
        flags.push(
          makeFlag(
            'feed_regressed',
            'Feed reports event status "upcoming" while the championship is in tournament phase',
            { detail: { feedStatus: i.feedStatus } },
          ),
        );
      }

      if (nowMs > endMs + OVERDUE_CONCLUSION_HOURS * HOUR_MS) {
        reasons.push(
          `Championship is more than ${OVERDUE_CONCLUSION_HOURS}h past scheduled end without conclusion`,
        );
        flags.push(
          makeFlag(
            'overdue_conclusion',
            `Championship has not concluded more than ${OVERDUE_CONCLUSION_HOURS}h past scheduled end (${i.scheduledEnd.toISOString()})`,
            { detail: { scheduledEnd: i.scheduledEnd.toISOString() } },
          ),
        );
      }

      if (
        !i.feedOk &&
        i.lastFeedOkAt !== null &&
        nowMs - i.lastFeedOkAt.getTime() > FEED_OUTAGE_ALERT_HOURS * HOUR_MS
      ) {
        reasons.push(`No usable feed data for more than ${FEED_OUTAGE_ALERT_HOURS}h`);
        flags.push(
          makeFlag(
            'feed_unavailable',
            `Approved feeds have been unavailable for more than ${FEED_OUTAGE_ALERT_HOURS}h (last ok at ${i.lastFeedOkAt.toISOString()})`,
            { detail: { lastFeedOkAt: i.lastFeedOkAt.toISOString() } },
          ),
        );
      }
    }
  } else {
    // post_tournament never changes automatically.
  }

  if (i.locked) {
    if (wouldNext !== i.phase) {
      return {
        next: i.phase,
        reasons: [
          `Phase is locked at ${i.phase}; would have transitioned to ${wouldNext}: ${reasons.join('; ')}`,
        ],
        flags,
      };
    }
    return {
      next: i.phase,
      reasons: reasons.length > 0 ? reasons : [`Phase is locked at ${i.phase}`],
      flags,
    };
  }

  return { next: wouldNext, reasons, flags };
}
