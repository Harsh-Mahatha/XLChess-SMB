import { Chess } from 'chess.js';
import type { GameResult } from '@smb/shared';

export interface KeyMoment {
  ply: number;
  moveNumber: number;
  side: 'white' | 'black';
  san: string;
  /** Engine evaluation in pawns from White's point of view; mates are capped at +/-10. */
  evalBefore: number;
  evalAfter: number;
  swing: number;
  mateAppears: boolean;
}

export type GameCheck =
  | { ok: true; plies: number; moments: KeyMoment[]; hasEvals: boolean }
  | { ok: false; code: 'pgn_invalid' | 'result_mismatch'; detail: string };

const MATE_CAP = 10;
const TOKEN =
  /\{[^}]*\}|;[^\n]*|\$\d+|\d+\.(?:\.\.)?|1-0|0-1|1\/2-1\/2|\*|\([^()]*\)|[^\s{}();$]+/g;
const EVAL = /\[%eval\s+(#?-?\d+(?:\.\d+)?)\]/;

interface Ply {
  san: string;
  evaluation?: number;
  mate?: boolean;
}

function parseEval(text: string): { value: number; mate: boolean } | undefined {
  const m = EVAL.exec(text);
  if (!m) return undefined;
  const raw = m[1]!;
  if (raw.startsWith('#')) {
    const n = Number(raw.slice(1));
    return { value: n < 0 ? -MATE_CAP : MATE_CAP, mate: true };
  }
  const v = Number(raw);
  return { value: Math.max(-MATE_CAP, Math.min(MATE_CAP, v)), mate: false };
}

/** Moves and the engine evaluation printed after each, read from the movetext. */
function readPlies(pgn: string): Ply[] {
  const movetext = pgn
    .split('\n')
    .filter((l) => !l.startsWith('['))
    .join('\n');
  const plies: Ply[] = [];
  for (const [token] of movetext.matchAll(TOKEN)) {
    if (token.startsWith('{')) {
      const last = plies.at(-1);
      const ev = last ? parseEval(token) : undefined;
      if (last && ev) {
        last.evaluation = ev.value;
        last.mate = ev.mate;
      }
    } else if (
      token.startsWith(';') ||
      token.startsWith('$') ||
      token.startsWith('(') ||
      /^\d+\./.test(token) ||
      ['1-0', '0-1', '1/2-1/2', '*'].includes(token)
    ) {
      continue;
    } else {
      plies.push({ san: token.replace(/[!?]+$/, '') });
    }
  }
  return plies;
}

function expectedFromPosition(chess: Chess): GameResult | undefined {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0';
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return '1/2-1/2';
  return undefined;
}

/**
 * Replays the PGN with a chess engine to prove the moves are legal, and checks the Result tag does not
 * contradict a finished position (checkmate, stalemate). Resignations, flags and agreed draws cannot be
 * proven from the moves, so any result is accepted for those. Also extracts the biggest evaluation swings.
 */
export function checkGame(pgn: string, result: GameResult, minSwing = 1.5, top = 3): GameCheck {
  const chess = new Chess();
  try {
    // The parser accepts one comment per move; Lichess writes several ({eval} {text} {clock}).
    // Replay a comment-free copy, and read the evaluations from the original text below.
    chess.loadPgn(pgn.replace(/\{[^}]*\}/g, ' '));
  } catch (err) {
    return {
      ok: false,
      code: 'pgn_invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const expected = expectedFromPosition(chess);
  if (expected && result !== '*' && expected !== result) {
    return {
      ok: false,
      code: 'result_mismatch',
      detail: `Result tag is ${result} but the final position implies ${expected}`,
    };
  }

  const history = chess.history();
  const plies = readPlies(pgn);
  const aligned = plies.length === history.length;
  const moments: KeyMoment[] = [];
  const hasEvals = aligned && plies.some((p) => p.evaluation !== undefined);
  if (hasEvals) {
    for (let i = 1; i < plies.length; i++) {
      const before = plies[i - 1]!;
      const after = plies[i]!;
      if (before.evaluation === undefined || after.evaluation === undefined) continue;
      const swing = Math.abs(after.evaluation - before.evaluation);
      const mateAppears = Boolean(after.mate) && !before.mate;
      if (swing < minSwing && !mateAppears) continue;
      moments.push({
        ply: i + 1,
        moveNumber: Math.floor(i / 2) + 1,
        side: i % 2 === 0 ? 'white' : 'black',
        san: history[i]!,
        evalBefore: before.evaluation,
        evalAfter: after.evaluation,
        swing: Math.round(swing * 100) / 100,
        mateAppears,
      });
    }
  }
  moments.sort((a, b) => b.swing - a.swing || a.ply - b.ply);
  return {
    ok: true,
    plies: history.length,
    moments: moments.slice(0, top).sort((a, b) => a.ply - b.ply),
    hasEvals,
  };
}
