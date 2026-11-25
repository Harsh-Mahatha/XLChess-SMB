export const CHAMPIONSHIP_PHASES = ['pre_tournament', 'tournament', 'post_tournament'] as const;
export type ChampionshipPhase = (typeof CHAMPIONSHIP_PHASES)[number];

export const GAME_KINDS = ['classical', 'tiebreak'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const GAME_STATES = ['scheduled', 'in_progress', 'result_observed', 'confirmed'] as const;
export type GameState = (typeof GAME_STATES)[number];

export const CONFIRMATION_BASES = ['official_entry', 'corroborated'] as const;
export type ConfirmationBasis = (typeof CONFIRMATION_BASES)[number];

export const POST_STATUSES = ['none', 'held', 'opportunity_created', 'stale_skipped'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const START_EARLY_TOLERANCE_HOURS = 24;
export const START_LATE_GRACE_HOURS = 24;
export const OVERDUE_CONCLUSION_HOURS = 48;
export const FEED_OUTAGE_ALERT_HOURS = 6;

export const FLAG_KINDS = [
  'premature_start',
  'late_start',
  'feed_regressed',
  'identity_mismatch',
  'feed_unavailable',
  'unconfirmed_games',
  'conclusion_unconfirmed',
  'no_unique_winner',
  'overdue_conclusion',
  'game_conflict',
  'result_corrected',
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export type FlagSeverity = 'blocking' | 'advisory';

export interface FlagDraft {
  kind: FlagKind;
  severity: FlagSeverity;
  autoClear: boolean;
  gameNumber?: number;
  message: string;
  detail?: Record<string, unknown>;
}

export const FLAG_RULES: Record<FlagKind, { severity: FlagSeverity; autoClear: boolean }> = {
  premature_start: { severity: 'blocking', autoClear: true },
  late_start: { severity: 'blocking', autoClear: true },
  feed_regressed: { severity: 'blocking', autoClear: true },
  identity_mismatch: { severity: 'blocking', autoClear: true },
  feed_unavailable: { severity: 'advisory', autoClear: true },
  unconfirmed_games: { severity: 'advisory', autoClear: true },
  conclusion_unconfirmed: { severity: 'advisory', autoClear: true },
  no_unique_winner: { severity: 'advisory', autoClear: true },
  overdue_conclusion: { severity: 'advisory', autoClear: true },
  game_conflict: { severity: 'advisory', autoClear: true },
  result_corrected: { severity: 'advisory', autoClear: false },
};

export function makeFlag(
  kind: FlagKind,
  message: string,
  opts?: { gameNumber?: number; detail?: Record<string, unknown> },
): FlagDraft {
  const rule = FLAG_RULES[kind];
  return {
    kind,
    severity: rule.severity,
    autoClear: rule.autoClear,
    ...(opts?.gameNumber !== undefined ? { gameNumber: opts.gameNumber } : {}),
    message,
    ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
  };
}
