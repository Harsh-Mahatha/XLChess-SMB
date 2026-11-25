import { Router, type Request, type Response } from 'express';
import { matchScore, type SourcesRegistry } from '@smb/shared';
import type { Logger } from 'pino';
import type { PrismaClient } from '@prisma/client';
import { actorOf, authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import { loadConfigSet } from '../../config/loader.js';
import type { ContextResolvers } from '../../scheduling/context.js';
import {
  PrismaSourceRecordStore,
  createSourceGateway,
  type SourceGateway,
} from '../../sources/index.js';
import { HttpError } from '../errors.js';
import {
  AddTiebreakBody,
  ChampionshipError,
  ChampionshipIdParam,
  ConcludeCycleBody,
  ConfirmGameBody,
  ConfirmGameParams,
  EditCycleBody,
  ForcePhaseBody,
  ListChampionshipsQuery,
  RegisterCycleBody,
  ResolveFlagBody,
  ResolveFlagParams,
} from '../../championship/types.js';
import {
  addTiebreakGame,
  concludeCycle,
  confirmGame,
  editCycle,
  forcePhase,
  registerCycle,
  resolveFlag,
  unlockCycle,
} from '../../championship/service.js';
import { syncChampionship } from '../../championship/sync.js';

export interface ChampionshipRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
  gateway?: SourceGateway;
  registry?: SourcesRegistry;
  resolvers?: ContextResolvers;
  logger: Logger;
  now?: () => Date;
}

function toHttpError(err: unknown): never {
  if (err instanceof ChampionshipError) {
    throw new HttpError(err.status, err.code, err.message, err.details);
  }
  throw err;
}

function formatCycle(c: {
  id: string;
  post_type_id: string;
  cycle_key: string;
  title: string;
  official_url: string;
  venue: string | null;
  scheduled_start: Date;
  scheduled_end: Date;
  total_games: number;
  player_a: unknown;
  player_b: unknown;
  source_event_refs: unknown;
  phase: string;
  phase_locked: boolean;
  phase_lock_reason: string | null;
  is_current: boolean;
  confirmed_start: Date | null;
  confirmed_end: Date | null;
  winner: string | null;
  next_cycle: unknown;
  last_synced_at: Date | null;
  last_sync_status: string | null;
  last_feed_ok_at: Date | null;
  last_feed_status: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: c.id,
    postTypeId: c.post_type_id,
    cycleKey: c.cycle_key,
    title: c.title,
    officialUrl: c.official_url,
    venue: c.venue,
    scheduledStart: c.scheduled_start.toISOString(),
    scheduledEnd: c.scheduled_end.toISOString(),
    totalGames: c.total_games,
    playerA: c.player_a,
    playerB: c.player_b,
    sourceEventRefs: c.source_event_refs,
    phase: c.phase,
    phaseLocked: c.phase_locked,
    phaseLockReason: c.phase_lock_reason,
    isCurrent: c.is_current,
    confirmedStart: c.confirmed_start?.toISOString() ?? null,
    confirmedEnd: c.confirmed_end?.toISOString() ?? null,
    winner: c.winner,
    nextCycle: c.next_cycle,
    lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
    lastSyncStatus: c.last_sync_status,
    lastFeedOkAt: c.last_feed_ok_at?.toISOString() ?? null,
    lastFeedStatus: c.last_feed_status,
    createdBy: c.created_by,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

function formatGame(g: {
  id: string;
  cycle_id: string;
  kind: string;
  game_number: number;
  idempotency_key: string;
  state: string;
  scheduled_at: Date | null;
  white_player: string | null;
  result: string | null;
  d3_game_id: string | null;
  d3_round_id: string | null;
  round_label: string | null;
  round_name: string | null;
  round_url: string | null;
  played_at: Date | null;
  observed_at: Date | null;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  confirmation_basis: string | null;
  result_version: number;
  opportunity_id: string | null;
  post_status: string;
}) {
  return {
    id: g.id,
    cycleId: g.cycle_id,
    kind: g.kind,
    gameNumber: g.game_number,
    idempotencyKey: g.idempotency_key,
    state: g.state,
    scheduledAt: g.scheduled_at?.toISOString() ?? null,
    whitePlayer: g.white_player,
    observedResult: g.state === 'result_observed' ? g.result : null,
    confirmedResult: g.state === 'confirmed' ? g.result : null,
    result: g.result,
    d3GameId: g.d3_game_id,
    d3RoundId: g.d3_round_id,
    roundLabel: g.round_label,
    roundName: g.round_name,
    roundUrl: g.round_url,
    playedAt: g.played_at?.toISOString() ?? null,
    observedAt: g.observed_at?.toISOString() ?? null,
    confirmedAt: g.confirmed_at?.toISOString() ?? null,
    confirmedBy: g.confirmed_by,
    confirmationBasis: g.confirmation_basis,
    resultVersion: g.result_version,
    opportunityId: g.opportunity_id,
    postStatus: g.post_status,
  };
}

function formatFlag(f: {
  id: string;
  cycle_id: string;
  kind: string;
  severity: string;
  auto_clear: boolean;
  game_number: number | null;
  message: string;
  detail: unknown;
  status: string;
  opened_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
}) {
  return {
    id: f.id,
    cycleId: f.cycle_id,
    kind: f.kind,
    severity: f.severity,
    autoClear: f.auto_clear,
    gameNumber: f.game_number,
    message: f.message,
    detail: f.detail,
    status: f.status,
    openedAt: f.opened_at.toISOString(),
    resolvedAt: f.resolved_at?.toISOString() ?? null,
    resolvedBy: f.resolved_by,
    resolutionNote: f.resolution_note,
  };
}

export function championshipsRouter(deps: ChampionshipRouteDeps): Router {
  const router = Router();
  const auth = [authenticate(deps.verifier), requireRole('admin')];
  const { db } = deps;
  const serviceDeps = { db, now: deps.now, logger: deps.logger };

  // 1. POST /v1/championships
  router.post('/v1/championships', ...auth, async (req: Request, res: Response) => {
    const body = RegisterCycleBody.parse(req.body);
    const actor = actorOf(res).userId;
    try {
      const created = await registerCycle(serviceDeps, actor, body);
      res.status(201).json({
        cycle: formatCycle(created.cycle),
        games: created.games.map(formatGame),
      });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 2. GET /v1/championships
  router.get('/v1/championships', ...auth, async (req: Request, res: Response) => {
    const query = ListChampionshipsQuery.parse(req.query);
    const rows = await db.championship_cycles.findMany({
      where: query.current !== undefined ? { is_current: query.current } : undefined,
      orderBy: { created_at: 'desc' },
    });
    res.json({ championships: rows.map(formatCycle) });
  });

  // 3. GET /v1/championships/:id
  router.get('/v1/championships/:id', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const cycle = await db.championship_cycles.findUnique({ where: { id } });
    if (!cycle) {
      throw new HttpError(404, 'not_found', 'Championship cycle not found');
    }

    const [games, openFlags, logRows] = await Promise.all([
      db.championship_games.findMany({
        where: { cycle_id: id },
        orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
      }),
      db.championship_flags.findMany({
        where: { cycle_id: id, status: 'open' },
        orderBy: { opened_at: 'asc' },
      }),
      db.championship_log.findMany({
        where: { cycle_id: id },
        orderBy: { at: 'desc' },
        take: 100,
      }),
    ]);

    const score = matchScore(
      games.map((g) => ({
        kind: g.kind as 'classical' | 'tiebreak',
        state: g.state as 'scheduled' | 'in_progress' | 'result_observed' | 'confirmed',
        result: g.result as '1-0' | '0-1' | '1/2-1/2' | null,
        whitePlayer: g.white_player as 'a' | 'b' | null,
      })),
      'classical',
    );

    const nextAction: string[] = [];
    for (const g of games) {
      if (g.state === 'result_observed') {
        const label = g.kind === 'tiebreak' ? `tiebreak ${g.game_number}` : `game ${g.game_number}`;
        nextAction.push(`confirm ${label}: feed reports ${g.result}`);
      }
    }
    for (const f of openFlags) {
      if (f.kind === 'conclusion_unconfirmed') {
        nextAction.push('conclude championship: a player has clinched the match');
      } else if (f.kind === 'no_unique_winner') {
        nextAction.push('add tiebreak game or conclude championship');
      } else if (!f.auto_clear) {
        nextAction.push(`resolve flag ${f.kind}${f.game_number ? ` (game ${f.game_number})` : ''}`);
      } else if (f.severity === 'blocking') {
        nextAction.push(`blocking flag ${f.kind}: ${f.message}`);
      }
    }

    res.json({
      cycle: formatCycle(cycle),
      games: games.map(formatGame),
      score,
      openFlags: openFlags.map(formatFlag),
      log: logRows.map((l) => ({
        id: String(l.id),
        at: l.at.toISOString(),
        kind: l.kind,
        actor: l.actor,
        message: l.message,
        detail: l.detail,
      })),
      nextAction,
    });
  });

  // 4. PATCH /v1/championships/:id
  router.patch('/v1/championships/:id', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const body = EditCycleBody.parse(req.body);
    const actor = actorOf(res).userId;
    try {
      const updated = await editCycle(serviceDeps, actor, id, body);
      res.json({
        cycle: formatCycle(updated.cycle),
        games: updated.games.map(formatGame),
      });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 5. POST /v1/championships/:id/games
  router.post('/v1/championships/:id/games', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const body = AddTiebreakBody.parse(req.body);
    const actor = actorOf(res).userId;
    try {
      const game = await addTiebreakGame(serviceDeps, actor, id, body);
      res.status(201).json({ game: formatGame(game) });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 6. POST /v1/championships/:id/games/:kind/:number/confirm
  router.post(
    '/v1/championships/:id/games/:kind/:number/confirm',
    ...auth,
    async (req: Request, res: Response) => {
      const params = ConfirmGameParams.parse(req.params);
      const body = ConfirmGameBody.parse(req.body);
      const actor = actorOf(res).userId;
      try {
        const result = await confirmGame(
          serviceDeps,
          actor,
          params.id,
          params.kind,
          params.number,
          body,
        );
        res.json({
          cycle: formatCycle(result.cycle),
          game: formatGame(result.game),
          corrected: result.corrected,
          noOp: result.noOp,
          emit: result.emit,
        });
      } catch (err) {
        toHttpError(err);
      }
    },
  );

  // 7. POST /v1/championships/:id/conclude
  router.post('/v1/championships/:id/conclude', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const body = ConcludeCycleBody.parse(req.body);
    const actor = actorOf(res).userId;
    try {
      const cycle = await concludeCycle(serviceDeps, actor, id, body);
      res.json({ cycle: formatCycle(cycle) });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 8. POST /v1/championships/:id/phase
  router.post('/v1/championships/:id/phase', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const body = ForcePhaseBody.parse(req.body);
    const actor = actorOf(res).userId;
    try {
      const cycle = await forcePhase(serviceDeps, actor, id, body);
      res.json({ cycle: formatCycle(cycle) });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 9. POST /v1/championships/:id/unlock
  router.post('/v1/championships/:id/unlock', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const actor = actorOf(res).userId;
    try {
      const cycle = await unlockCycle(serviceDeps, actor, id);
      res.json({ cycle: formatCycle(cycle) });
    } catch (err) {
      toHttpError(err);
    }
  });

  // 10. POST /v1/championships/:id/flags/:flagId/resolve
  router.post(
    '/v1/championships/:id/flags/:flagId/resolve',
    ...auth,
    async (req: Request, res: Response) => {
      const params = ResolveFlagParams.parse(req.params);
      const body = ResolveFlagBody.parse(req.body);
      const actor = actorOf(res).userId;
      try {
        const flag = await resolveFlag(serviceDeps, actor, params.flagId, body, params.id);
        res.json({ flag: formatFlag(flag) });
      } catch (err) {
        toHttpError(err);
      }
    },
  );

  // 11. POST /v1/championships/:id/sync
  router.post('/v1/championships/:id/sync', ...auth, async (req: Request, res: Response) => {
    const { id } = ChampionshipIdParam.parse(req.params);
    const cycle = await db.championship_cycles.findUnique({ where: { id } });
    if (!cycle) {
      throw new HttpError(404, 'not_found', 'Championship cycle not found');
    }
    if (!cycle.is_current) {
      throw new HttpError(
        409,
        'not_current_cycle',
        'Only the current championship cycle can be synced',
      );
    }
    const registry = deps.registry ?? loadConfigSet().sources;
    const gateway = deps.gateway ?? createSourceGateway(registry, new PrismaSourceRecordStore(db));
    const summary = await syncChampionship(
      {
        db,
        gateway,
        registry,
        resolvers: deps.resolvers,
        logger: deps.logger,
      },
      { now: deps.now ? deps.now() : undefined, force: true },
    );
    res.json({ summary });
  });

  return router;
}
