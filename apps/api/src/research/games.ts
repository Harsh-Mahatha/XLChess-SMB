import {
  CONFLICT_CONFIDENCE,
  weakestVerification,
  type ChessGame,
  type ClaimVerification,
  type GameResult,
  type PackageIssue,
  type SourceReliability,
  type Sourced,
} from '@smb/shared';
import { checkGame, type GameCheck, type KeyMoment } from './chess.js';
import type { PlayerDirectory } from './identity.js';
import { assess, type Assessment, type Observation } from './verify.js';

export interface AssessedGame {
  key: string;
  whiteKey: string;
  blackKey: string;
  roundNo: number | null;
  /** Every provider record that describes this game. */
  records: Sourced<ChessGame>[];
  /** Support for the result. When `verification` is conflicting, `result` is null. */
  assessment: Assessment;
  result: GameResult | null;
  moments: KeyMoment[];
  hasEvals: boolean;
}

function roundNumber(round: string | undefined): number | null {
  const n = Number.parseInt(round ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Groups provider records into games (same round, same white and black), proves each record's moves are
 * legal and its result is consistent, and assesses the result across sources. A record that fails the
 * check is excluded from the result and reported in `issues`; if none pass, the game is conflicting.
 */
export function assessGames(
  records: Sourced<ChessGame>[],
  reliabilityOf: (sourceId: string) => SourceReliability,
  directory: PlayerDirectory,
  issues: PackageIssue[],
): AssessedGame[] {
  const groups = new Map<string, Sourced<ChessGame>[]>();
  for (const r of records) {
    const w = directory.keyOf(r.data.white);
    const b = directory.keyOf(r.data.black);
    const key = `${roundNumber(r.data.round) ?? 'x'}|${w}|${b}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const out: AssessedGame[] = [];
  for (const [key, recs] of groups) {
    const observations: Observation[] = [];
    const invalidIds: string[] = [];
    const invalidHashes: string[] = [];
    let chosen: Extract<GameCheck, { ok: true }> | undefined;
    for (const rec of recs) {
      const check = checkGame(rec.data.pgn, rec.data.result);
      if (!check.ok) {
        issues.push({ code: check.code, url: rec.provenance.url, detail: check.detail });
        invalidIds.push(rec.provenance.recordId);
        invalidHashes.push(rec.provenance.payloadHash);
        continue;
      }
      chosen ??= check;
      observations.push({
        sourceId: rec.provenance.sourceId,
        reliability: reliabilityOf(rec.provenance.sourceId),
        value: rec.data.result,
        recordId: rec.provenance.recordId,
        payloadHash: rec.provenance.payloadHash,
      });
    }

    let assessment: Assessment;
    if (observations.length === 0) {
      assessment = {
        value: {
          conflict: recs.map((r) => ({ sourceId: r.provenance.sourceId, value: 'invalid' })),
        },
        verification: 'conflicting',
        confidence: CONFLICT_CONFIDENCE,
        recordIds: invalidIds,
        payloadHashes: invalidHashes,
        conflict: {
          resolved: false,
          candidates: recs.map((r) => ({ sourceId: r.provenance.sourceId, value: r.data.result })),
        },
      };
    } else {
      assessment = assess(observations);
      assessment.recordIds = [...new Set([...assessment.recordIds, ...invalidIds])];
      assessment.payloadHashes = [...new Set([...assessment.payloadHashes, ...invalidHashes])];
    }

    const first = recs[0]!.data;
    out.push({
      key,
      whiteKey: directory.keyOf(first.white),
      blackKey: directory.keyOf(first.black),
      roundNo: roundNumber(first.round),
      records: recs,
      assessment,
      result: assessment.verification === 'conflicting' ? null : (assessment.value as GameResult),
      moments: chosen?.moments ?? [],
      hasEvals: chosen?.hasEvals ?? false,
    });
  }
  return out.sort((a, b) => (a.roundNo ?? 0) - (b.roundNo ?? 0) || a.key.localeCompare(b.key));
}

const POINTS: Record<Exclude<GameResult, '*'>, [number, number]> = {
  '1-0': [1, 0],
  '0-1': [0, 1],
  '1/2-1/2': [0.5, 0.5],
};

export interface Tally {
  points: Map<string, number>;
  completed: AssessedGame[];
  inProgress: number;
  verification: ClaimVerification;
  confidence: number;
  recordIds: string[];
  payloadHashes: string[];
}

/**
 * Adds up points over the completed games in `games`. The tally is only as verified as the weakest
 * game it counts, and a game whose result is in conflict poisons it. Games still in progress are
 * counted separately and never scored.
 */
export function tally(games: AssessedGame[]): Tally {
  const points = new Map<string, number>();
  const completed: AssessedGame[] = [];
  let inProgress = 0;
  const counted: AssessedGame[] = [];
  for (const g of games) {
    if (g.result === null) {
      counted.push(g); // unresolved: keeps verification at "conflicting"
      continue;
    }
    if (g.result === '*') {
      inProgress++;
      continue;
    }
    const [w, b] = POINTS[g.result];
    points.set(g.whiteKey, (points.get(g.whiteKey) ?? 0) + w);
    points.set(g.blackKey, (points.get(g.blackKey) ?? 0) + b);
    completed.push(g);
    counted.push(g);
  }
  return {
    points,
    completed,
    inProgress,
    verification: weakestVerification(counted.map((g) => g.assessment.verification)),
    confidence: counted.length ? Math.min(...counted.map((g) => g.assessment.confidence)) : 0,
    recordIds: [...new Set(counted.flatMap((g) => g.assessment.recordIds))],
    payloadHashes: [...new Set(counted.flatMap((g) => g.assessment.payloadHashes))],
  };
}

export interface Standing {
  key: string;
  points: number;
}

/** Highest score first; ties keep a stable order. */
export function standings(t: Tally): Standing[] {
  return [...t.points.entries()]
    .map(([key, points]) => ({ key, points }))
    .sort((a, b) => b.points - a.points || a.key.localeCompare(b.key));
}

/** The unique top scorer, or null when two or more share the lead (tiebreaks are not calculated). */
export function leader(s: Standing[]): Standing | null {
  if (s.length === 0) return null;
  if (s.length > 1 && s[1]!.points === s[0]!.points) return null;
  return s[0]!;
}
