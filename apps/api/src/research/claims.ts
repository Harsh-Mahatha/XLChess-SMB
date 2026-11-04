import {
  FACT_CATALOGUE,
  isKnownFact,
  weakestVerification,
  type ChessEvent,
  type ChessGame,
  type ClaimDraft,
  type ClaimVerification,
  type ConflictNote,
  type FactKey,
  type MissingFact,
  type PackageIssue,
  type ResearchSubject,
  type SourceFailure,
  type SourceReliability,
  type Sourced,
} from '@smb/shared';
import { assessGames, leader, standings, tally, type AssessedGame, type Tally } from './games.js';
import { PlayerDirectory } from './identity.js';
import { assess, type Assessment, type Observation } from './verify.js';

export interface ClaimInput {
  subject: ResearchSubject;
  requiredFacts: string[];
  events: Sourced<ChessEvent>[];
  games: Sourced<ChessGame>[];
  failures: SourceFailure[];
  reliabilityOf: (sourceId: string) => SourceReliability;
}

export interface ClaimOutput {
  claims: ClaimDraft[];
  missing: MissingFact[];
  conflicts: ConflictNote[];
  issues: PackageIssue[];
}

type Built = { claim: ClaimDraft } | { missing: MissingFact };

const text = (v: unknown): string => String(v).toLowerCase().replace(/\s+/g, ' ').trim();
const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

/** Builds one claim per required fact, or says exactly why it could not. Never guesses a value. */
export function buildClaims(input: ClaimInput): ClaimOutput {
  const { events, games, failures, reliabilityOf } = input;
  const issues: PackageIssue[] = [];
  const conflicts: ConflictNote[] = [];
  const directory = new PlayerDirectory(games.flatMap((g) => [g.data.white, g.data.black]));
  const assessed = assessGames(games, reliabilityOf, directory, issues);
  const nameOf = (key: string): string => directory.person(key).name;

  const noData = (fact: string, detail: string): Built => ({
    missing: { fact, reason: failures.length ? 'source_failed' : 'no_data', detail },
  });

  const obs = (r: Sourced<unknown>, value: unknown): Observation => ({
    sourceId: r.provenance.sourceId,
    reliability: reliabilityOf(r.provenance.sourceId),
    value,
    recordId: r.provenance.recordId,
    payloadHash: r.provenance.payloadHash,
  });
  const eventObs = (pick: (e: ChessEvent) => unknown): Observation[] =>
    events.flatMap((ev) => {
      const v = pick(ev.data);
      return v === undefined ? [] : [obs(ev, v)];
    });

  function claim(
    fact: FactKey,
    a: Assessment,
    value: unknown,
    extra: Partial<ClaimDraft> = {},
  ): Built {
    if (a.conflict) conflicts.push({ claimKey: fact, ...a.conflict });
    return {
      claim: {
        claimKey: fact,
        description: FACT_CATALOGUE[fact].description,
        // An unresolved conflict stores every candidate value instead of picking one.
        value: a.verification === 'conflicting' && a.value !== null ? a.value : value,
        computed: FACT_CATALOGUE[fact].computed,
        verification: a.verification,
        confidence: a.confidence,
        evidenceRecordIds: a.recordIds,
        evidencePayloadHashes: a.payloadHashes,
        ...extra,
      },
    };
  }

  /** A claim for a simple descriptive fact read from the event record(s). */
  function fromEvents(
    fact: FactKey,
    pick: (e: ChessEvent) => unknown,
    canon: (v: unknown) => string,
    eventTime?: (value: unknown) => string | undefined,
  ): Built {
    const o = eventObs(pick);
    if (o.length === 0) return noData(fact, 'the event record does not provide it');
    const a = assess(o, canon);
    return claim(fact, a, a.value, { eventTime: eventTime?.(a.value) });
  }

  const subjectGame = (): AssessedGame | undefined => {
    const ref = input.subject.gameRef;
    return ref
      ? assessed.find((g) =>
          g.records.some(
            (r) => r.provenance.sourceId === ref.sourceId && r.data.externalId === ref.externalId,
          ),
        )
      : undefined;
  };

  const pairGames = (g: AssessedGame): AssessedGame[] =>
    assessed.filter(
      (x) =>
        (x.whiteKey === g.whiteKey && x.blackKey === g.blackKey) ||
        (x.whiteKey === g.blackKey && x.blackKey === g.whiteKey),
    );

  const scoreValue = (g: AssessedGame, t: Tally) => ({
    players: [g.whiteKey, g.blackKey].map((k) => ({
      name: nameOf(k),
      fideId: directory.person(k).fideId,
      points: t.points.get(k) ?? 0,
    })),
    completedGames: t.completed.length,
    inProgressGames: t.inProgress,
    games: t.completed.map((c) => ({
      round: c.records[0]!.data.round,
      white: nameOf(c.whiteKey),
      black: nameOf(c.blackKey),
      result: c.result,
    })),
  });

  const latestPlayed = (list: AssessedGame[]): string | undefined =>
    list
      .flatMap((g) => g.records.map((r) => r.data.playedAt))
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1);

  /** Assessment of how many rounds are not finished, across the event records. */
  const roundsRemaining = (): Assessment & { total: number } => {
    const a = assess(
      eventObs((e) => e.rounds.filter((r) => r.status !== 'completed').length),
      text,
    );
    const total = Math.max(0, ...events.map((e) => e.data.rounds.length));
    return Object.assign(a, { total });
  };

  const builders: Record<FactKey, () => Built> = {
    'event.name': () => fromEvents('event.name', (e) => e.name, text),
    'event.dates': () =>
      fromEvents(
        'event.dates',
        (e) => (e.startDate ? { start: e.startDate, end: e.endDate } : undefined),
        (v) => `${day((v as { start: string }).start)}/${day((v as { end?: string }).end)}`,
        (v) => (v as { start: string }).start,
      ),
    'event.venue': () => fromEvents('event.venue', (e) => e.location, text),
    format: () =>
      fromEvents(
        'format',
        (e) =>
          e.format || e.timeControl ? { format: e.format, timeControl: e.timeControl } : undefined,
        (v) => text(JSON.stringify(v)),
      ),

    participants: () => {
      if (games.length === 0) return noData('participants', 'no games retrieved yet');
      const o = games.map((g) =>
        obs(
          g,
          [g.data.white, g.data.black].map((p) => directory.keyOf(p)),
        ),
      );
      // One value per source: the set of players that source has seen.
      const perSource = new Map<string, Set<string>>();
      for (const x of o) {
        const s = perSource.get(x.sourceId) ?? new Set<string>();
        (x.value as string[]).forEach((k) => s.add(k));
        perSource.set(x.sourceId, s);
      }
      const merged = o.map((x) => ({ ...x, value: [...perSource.get(x.sourceId)!].sort() }));
      const a = assess(merged, (v) => (v as string[]).join('|'));
      const value = directory.all().map(({ name, fideId, title, rating }) => ({
        name,
        fideId,
        title,
        rating,
      }));
      return claim('participants', a, value, {
        computation:
          'distinct players across all retrieved games, merged by FIDE id or normalised name',
      });
    },

    'game.result': () => {
      const g = subjectGame();
      if (!g) {
        return input.subject.gameRef
          ? noData('game.result', 'the game was not found in the retrieved data')
          : {
              missing: {
                fact: 'game.result',
                reason: 'not_applicable_yet',
                detail: 'the post is not about a single game',
              },
            };
      }
      const first = g.records[0]!.data;
      return claim(
        'game.result',
        g.assessment,
        {
          result: g.result,
          white: nameOf(g.whiteKey),
          black: nameOf(g.blackKey),
          round: first.round,
          moveCheck: 'moves replayed legally; result consistent with the final position',
        },
        { eventTime: first.playedAt },
      );
    },

    'game.key_moments': () => {
      const g = subjectGame();
      if (!g) return noData('game.key_moments', 'no game to analyse');
      if (!g.hasEvals) return noData('game.key_moments', 'the PGN has no engine evaluations');
      // Evaluations come from the provider, so they are never more than single-source.
      const verification = weakestVerification([g.assessment.verification, 'single_source']);
      return claim('game.key_moments', { ...g.assessment, verification }, g.moments, {
        computation:
          'largest swings in the engine evaluation ([%eval], White perspective, pawns): swing >= 1.5 or a mate appears; top 3',
        eventTime: g.records[0]!.data.playedAt,
      });
    },

    'match.score': () => {
      const g = subjectGame();
      if (!g) return noData('match.score', 'no game to identify the match');
      const t = tally(pairGames(g));
      if (t.recordIds.length === 0)
        return noData('match.score', 'no completed games between these players yet');
      return claim(
        'match.score',
        {
          value: null,
          verification: t.verification,
          confidence: t.confidence,
          recordIds: t.recordIds,
          payloadHashes: t.payloadHashes,
        },
        scoreValue(g, t),
        {
          computation:
            'sum of points (win 1, draw 0.5, loss 0) over completed games between the two players',
          eventTime: latestPlayed(t.completed),
        },
      );
    },

    'match.situation': () => {
      const g = subjectGame();
      if (!g) return noData('match.situation', 'no game to identify the match');
      const t = tally(pairGames(g));
      const rem = roundsRemaining();
      if (t.recordIds.length === 0 || rem.verification === 'unverified') {
        return noData('match.situation', 'needs completed games and the event schedule');
      }
      const lead = leader(standings(t));
      const second = standings(t)[1]?.points ?? 0;
      const verification: ClaimVerification = weakestVerification([
        t.verification,
        rem.verification,
      ]);
      return claim(
        'match.situation',
        {
          value: null,
          verification,
          confidence: Math.min(t.confidence, rem.confidence),
          recordIds: [...new Set([...t.recordIds, ...rem.recordIds])],
          payloadHashes: [...new Set([...t.payloadHashes, ...rem.payloadHashes])],
        },
        {
          leader: lead ? nameOf(lead.key) : null,
          tied: lead === null,
          margin: lead ? lead.points - second : 0,
          roundsRemaining: rem.value,
          totalRounds: rem.total,
        },
        {
          computation:
            'leader = unique top scorer of the match score; margin = lead over the other player; rounds remaining = rounds not yet finished',
          eventTime: latestPlayed(t.completed),
        },
      );
    },

    next_game: () => {
      const o = eventObs((e) => {
        const next = e.rounds
          .filter((r) => r.status === 'upcoming')
          .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))[0];
        return next ? { name: next.name, startsAt: next.startsAt, url: next.url } : undefined;
      });
      if (o.length === 0) {
        return {
          missing: {
            fact: 'next_game',
            reason: 'not_applicable_yet',
            detail: 'no upcoming round in the schedule',
          },
        };
      }
      const a = assess(
        o,
        (v) =>
          `${text((v as { name: string }).name)}@${(v as { startsAt?: string }).startsAt ?? ''}`,
      );
      return claim('next_game', a, a.value, {
        eventTime: (a.value as { startsAt?: string }).startsAt,
      });
    },

    'event.outcome': () => {
      const status = assess(
        eventObs((e) => e.status),
        text,
      );
      if (status.verification === 'unverified') return noData('event.outcome', 'no event status');
      if (status.value !== 'completed') {
        return {
          missing: {
            fact: 'event.outcome',
            reason: 'not_applicable_yet',
            detail: `event status is ${String(status.value)}`,
          },
        };
      }
      const t = tally(assessed);
      if (t.completed.length === 0) return noData('event.outcome', 'no completed games');
      const table = standings(t);
      const lead = leader(table);
      return claim(
        'event.outcome',
        {
          value: null,
          verification: weakestVerification([t.verification, status.verification]),
          confidence: Math.min(t.confidence, status.confidence),
          recordIds: [...new Set([...t.recordIds, ...status.recordIds])],
          payloadHashes: [...new Set([...t.payloadHashes, ...status.payloadHashes])],
        },
        {
          winner: lead ? nameOf(lead.key) : null,
          tied: lead === null,
          tiebreaksApplied: false,
          standings: table.slice(0, 5).map((s) => ({ name: nameOf(s.key), points: s.points })),
          completedGames: t.completed.length,
          gamesNotFinished: t.inProgress,
        },
        {
          computation:
            'sum of points over all completed games; winner = unique top scorer (tiebreaks are not calculated)',
          eventTime: latestPlayed(t.completed),
        },
      );
    },

    'next_cycle.stage': () => ({
      missing: {
        fact: 'next_cycle.stage',
        reason: 'no_approved_source',
        detail: 'no approved source provides qualification-cycle information',
      },
    }),
  };

  const claims: ClaimDraft[] = [];
  const missing: MissingFact[] = [];
  for (const fact of input.requiredFacts) {
    if (!isKnownFact(fact)) {
      missing.push({ fact, reason: 'unknown_fact', detail: 'not in the fact catalogue' });
      continue;
    }
    const built = builders[fact]();
    if ('claim' in built) {
      // A claim is evidence-backed or it does not exist.
      if (built.claim.evidenceRecordIds.length === 0) {
        missing.push({ fact, reason: 'no_data', detail: 'no evidence records' });
      } else {
        claims.push(built.claim);
      }
    } else {
      missing.push(built.missing);
    }
  }
  return { claims, missing, conflicts, issues };
}
