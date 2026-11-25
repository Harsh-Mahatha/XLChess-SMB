import { Prisma } from '@prisma/client';
import type { ChampionshipPhase, GameKind } from '@smb/shared';
import { emitPendingGameEvents, recordCorrection, type EmitSummary } from './emit.js';
import { openManualFlag } from './flags.js';
import { writeChampionshipLog } from './log.js';
import {
  AddTiebreakBody,
  BindGameBody,
  ChampionshipError,
  ConcludeCycleBody,
  ConfirmGameBody,
  EditCycleBody,
  ForcePhaseBody,
  RegisterCycleBody,
  ResolveFlagBody,
  type AddTiebreakInput,
  type BindGameInput,
  type ChampionshipDeps,
  type ConcludeCycleInput,
  type ConfirmGameInput,
  type EditCycleInput,
  type ForcePhaseInput,
  type RegisterCycleInput,
  type ResolveFlagInput,
} from './types.js';

const PHASE_RANK: Record<ChampionshipPhase, number> = {
  pre_tournament: 1,
  tournament: 2,
  post_tournament: 3,
};

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function registerCycle(
  deps: ChampionshipDeps,
  actor: string,
  rawBody: RegisterCycleInput,
) {
  const body = RegisterCycleBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  try {
    return await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext('smb.championship:1.1'))`;
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + body.cycleKey}))`;

      const current = await tx.championship_cycles.findFirst({
        where: { post_type_id: '1.1', is_current: true },
      });
      if (current && current.phase !== 'post_tournament') {
        throw new ChampionshipError(
          409,
          'cycle_in_progress',
          `Current championship "${current.cycle_key}" is still in phase "${current.phase}"`,
        );
      }

      const existingKey = await tx.championship_cycles.findUnique({
        where: { cycle_key: body.cycleKey },
      });
      if (existingKey) {
        throw new ChampionshipError(
          409,
          'cycle_key_taken',
          `Championship cycleKey "${body.cycleKey}" already exists`,
        );
      }

      if (current) {
        await tx.championship_cycles.update({
          where: { id: current.id },
          data: { is_current: false },
        });
      }

      const created = await tx.championship_cycles.create({
        data: {
          post_type_id: '1.1',
          cycle_key: body.cycleKey,
          title: body.title,
          official_url: body.officialUrl,
          venue: body.venue ?? null,
          scheduled_start: new Date(body.scheduledStart),
          scheduled_end: new Date(body.scheduledEnd),
          total_games: body.totalGames,
          player_a: body.playerA as Prisma.InputJsonValue,
          player_b: body.playerB as Prisma.InputJsonValue,
          source_event_refs: (body.sourceEventRefs ?? {}) as Prisma.InputJsonValue,
          phase: 'pre_tournament',
          is_current: true,
          next_cycle: body.nextCycle ? (body.nextCycle as Prisma.InputJsonValue) : Prisma.JsonNull,
          created_by: actor,
          created_at: now,
          updated_at: now,
        },
      });

      const gameRows = Array.from({ length: body.totalGames }, (_, idx) => {
        const gameNumber = idx + 1;
        return {
          cycle_id: created.id,
          kind: 'classical',
          game_number: gameNumber,
          idempotency_key: `${body.cycleKey}:game-${gameNumber}:result`,
          state: 'scheduled',
          post_status: 'none',
        };
      });
      await tx.championship_games.createMany({ data: gameRows });

      await writeChampionshipLog(tx, {
        cycleId: created.id,
        kind: 'registered',
        actor,
        message: `Registered championship "${body.title}" (${body.cycleKey}) with ${body.totalGames} classical games`,
        detail: {
          cycleKey: body.cycleKey,
          totalGames: body.totalGames,
          previousCycleId: current?.id ?? null,
        },
        at: now,
      });

      await tx.audit_log.create({
        data: {
          actor,
          action: 'championship.register',
          target_type: 'championship_cycle',
          target_id: created.id,
          details: {
            cycleKey: body.cycleKey,
            title: body.title,
            totalGames: body.totalGames,
          },
        },
      });

      const games = await tx.championship_games.findMany({
        where: { cycle_id: created.id },
        orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
      });
      return { cycle: created, games };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ChampionshipError(
        409,
        'cycle_key_taken',
        `Championship cycleKey "${body.cycleKey}" already exists`,
      );
    }
    throw err;
  }
}

export async function editCycle(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  rawBody: EditCycleInput,
) {
  const body = EditCycleBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    const nonNextFields = [
      body.title,
      body.officialUrl,
      body.venue,
      body.scheduledStart,
      body.scheduledEnd,
      body.totalGames,
      body.playerA,
      body.playerB,
      body.sourceEventRefs,
    ].some((v) => v !== undefined);

    if (cycle.phase === 'post_tournament' && nonNextFields) {
      throw new ChampionshipError(
        409,
        'invalid_phase',
        'Only nextCycle may be edited while the championship is in post_tournament phase',
      );
    }

    if (
      (body.playerA !== undefined || body.playerB !== undefined) &&
      cycle.phase !== 'pre_tournament'
    ) {
      throw new ChampionshipError(
        409,
        'invalid_phase',
        'Players can only be edited while the championship is in pre_tournament phase',
      );
    }

    const nextStart = body.scheduledStart ? new Date(body.scheduledStart) : cycle.scheduled_start;
    const nextEnd = body.scheduledEnd ? new Date(body.scheduledEnd) : cycle.scheduled_end;
    if (nextEnd.getTime() <= nextStart.getTime()) {
      throw new ChampionshipError(
        400,
        'invalid_dates',
        'scheduledEnd must be after scheduledStart',
      );
    }

    if (body.totalGames !== undefined && body.totalGames !== cycle.total_games) {
      const confirmedAbove = await tx.championship_games.findFirst({
        where: {
          cycle_id: cycleId,
          kind: 'classical',
          state: 'confirmed',
          game_number: { gt: body.totalGames },
        },
      });
      if (confirmedAbove) {
        throw new ChampionshipError(
          409,
          'confirmed_games_exceed_total',
          `Cannot reduce totalGames to ${body.totalGames}: game ${confirmedAbove.game_number} is already confirmed`,
        );
      }

      if (body.totalGames > cycle.total_games) {
        const toAdd = [];
        for (let n = cycle.total_games + 1; n <= body.totalGames; n++) {
          toAdd.push({
            cycle_id: cycleId,
            kind: 'classical',
            game_number: n,
            idempotency_key: `${cycle.cycle_key}:game-${n}:result`,
            state: 'scheduled',
            post_status: 'none',
          });
        }
        await tx.championship_games.createMany({ data: toAdd });
      } else {
        await tx.championship_games.deleteMany({
          where: {
            cycle_id: cycleId,
            kind: 'classical',
            game_number: { gt: body.totalGames },
            state: { not: 'confirmed' },
          },
        });
      }
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const data: Prisma.championship_cyclesUpdateInput = { updated_at: now };

    if (body.title !== undefined) {
      before.title = cycle.title;
      after.title = body.title;
      data.title = body.title;
    }
    if (body.officialUrl !== undefined) {
      before.officialUrl = cycle.official_url;
      after.officialUrl = body.officialUrl;
      data.official_url = body.officialUrl;
    }
    if (body.venue !== undefined) {
      before.venue = cycle.venue;
      after.venue = body.venue;
      data.venue = body.venue;
    }
    if (body.scheduledStart !== undefined) {
      before.scheduledStart = cycle.scheduled_start.toISOString();
      after.scheduledStart = nextStart.toISOString();
      data.scheduled_start = nextStart;
    }
    if (body.scheduledEnd !== undefined) {
      before.scheduledEnd = cycle.scheduled_end.toISOString();
      after.scheduledEnd = nextEnd.toISOString();
      data.scheduled_end = nextEnd;
    }
    if (body.totalGames !== undefined) {
      before.totalGames = cycle.total_games;
      after.totalGames = body.totalGames;
      data.total_games = body.totalGames;
    }
    if (body.playerA !== undefined) {
      before.playerA = cycle.player_a;
      after.playerA = body.playerA;
      data.player_a = body.playerA as Prisma.InputJsonValue;
    }
    if (body.playerB !== undefined) {
      before.playerB = cycle.player_b;
      after.playerB = body.playerB;
      data.player_b = body.playerB as Prisma.InputJsonValue;
    }
    if (body.sourceEventRefs !== undefined) {
      before.sourceEventRefs = cycle.source_event_refs;
      after.sourceEventRefs = body.sourceEventRefs;
      data.source_event_refs = body.sourceEventRefs as Prisma.InputJsonValue;
    }
    if (body.nextCycle !== undefined) {
      before.nextCycle = cycle.next_cycle;
      after.nextCycle = body.nextCycle;
      data.next_cycle =
        body.nextCycle === null ? Prisma.JsonNull : (body.nextCycle as Prisma.InputJsonValue);
    }

    const updated = await tx.championship_cycles.update({
      where: { id: cycleId },
      data,
    });

    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'edited',
      actor,
      message: `Edited championship fields: ${Object.keys(after).join(', ') || 'none'}`,
      detail: { before, after },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.edit',
        target_type: 'championship_cycle',
        target_id: cycleId,
        details: { before, after } as Prisma.InputJsonValue,
      },
    });

    const games = await tx.championship_games.findMany({
      where: { cycle_id: cycleId },
      orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
    });
    return { cycle: updated, games };
  });
}

export async function addTiebreakGame(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  rawBody: AddTiebreakInput,
) {
  const body = AddTiebreakBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  try {
    return await deps.db.$transaction(async (tx) => {
      const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
      if (!cycle) {
        throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
      }
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

      if (cycle.phase !== 'tournament') {
        throw new ChampionshipError(
          409,
          'invalid_phase',
          `Tiebreak games can only be added in tournament phase (current: "${cycle.phase}")`,
        );
      }

      const game = await tx.championship_games.create({
        data: {
          cycle_id: cycleId,
          kind: 'tiebreak',
          game_number: body.gameNumber,
          idempotency_key: `${cycle.cycle_key}:tiebreak-${body.gameNumber}:result`,
          state: 'scheduled',
          scheduled_at: body.scheduledAt ? new Date(body.scheduledAt) : null,
          post_status: 'none',
        },
      });

      await writeChampionshipLog(tx, {
        cycleId,
        kind: 'edited',
        actor,
        message: `Added tiebreak game ${body.gameNumber}`,
        detail: { kind: 'tiebreak', gameNumber: body.gameNumber },
        at: now,
      });

      await tx.audit_log.create({
        data: {
          actor,
          action: 'championship.edit',
          target_type: 'championship_cycle',
          target_id: cycleId,
          details: {
            addedTiebreak: body.gameNumber,
            scheduledAt: body.scheduledAt ?? null,
          },
        },
      });

      return game;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ChampionshipError(
        409,
        'game_exists',
        `Tiebreak game ${body.gameNumber} already exists`,
      );
    }
    throw err;
  }
}

/**
 * 1.16 D8: binds a championship game to a D3 round and/or game, so feed games that do not carry a
 * plain classical round number (tiebreaks) are observed. A confirmed game's existing binding is
 * changed only with `force` and a reason.
 */
export async function bindGame(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  kind: GameKind,
  number: number,
  rawBody: BindGameInput,
) {
  const body = BindGameBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    const game = await tx.championship_games.findUnique({
      where: { cycle_id_kind_game_number: { cycle_id: cycleId, kind, game_number: number } },
    });
    if (!game)
      throw new ChampionshipError(404, 'game_not_found', `${kind} game ${number} not found`);

    const hasBinding = game.d3_round_id !== null || game.d3_game_id !== null;
    if (game.state === 'confirmed' && hasBinding && !body.force) {
      throw new ChampionshipError(
        409,
        'game_confirmed',
        `${kind} game ${number} is confirmed and already bound; pass force with a reason to change it`,
      );
    }

    if (body.d3GameId) {
      const clash = await tx.championship_games.findFirst({
        where: { cycle_id: cycleId, d3_game_id: body.d3GameId, NOT: { id: game.id } },
      });
      if (clash) {
        throw new ChampionshipError(
          409,
          'binding_in_use',
          `D3 game ${body.d3GameId} is already bound to ${clash.kind} game ${clash.game_number}`,
        );
      }
    }

    const updated = await tx.championship_games.update({
      where: { id: game.id },
      data: {
        ...(body.d3RoundId !== undefined ? { d3_round_id: body.d3RoundId } : {}),
        ...(body.d3GameId !== undefined ? { d3_game_id: body.d3GameId } : {}),
      },
    });

    const detail = {
      kind,
      gameNumber: number,
      d3RoundId: updated.d3_round_id,
      d3GameId: updated.d3_game_id,
      previous: { d3RoundId: game.d3_round_id, d3GameId: game.d3_game_id },
      force: body.force,
      reason: body.reason ?? null,
    };
    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'edited',
      actor,
      message: `Bound ${kind} game ${number} to D3 round ${updated.d3_round_id ?? '-'} / game ${updated.d3_game_id ?? '-'}`,
      detail,
      at: now,
    });
    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.bind_game',
        target_type: 'championship_game',
        target_id: game.id,
        details: { cycleId, ...detail },
      },
    });
    return updated;
  });
}

export async function confirmGame(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  kind: GameKind,
  number: number,
  rawBody: ConfirmGameInput,
) {
  const body = ConfirmGameBody.parse(rawBody);
  if (body.attested !== true) {
    throw new ChampionshipError(
      400,
      'attestation_required',
      'Confirming an official result requires attested: true',
    );
  }
  const now = deps.now ? deps.now() : new Date();

  const txResult = await deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    if (cycle.phase !== 'pre_tournament' && cycle.phase !== 'tournament') {
      throw new ChampionshipError(
        409,
        'invalid_phase',
        `Cannot confirm games while championship is in phase "${cycle.phase}"`,
      );
    }

    const game = await tx.championship_games.findUnique({
      where: {
        cycle_id_kind_game_number: {
          cycle_id: cycleId,
          kind,
          game_number: number,
        },
      },
    });
    if (!game) {
      throw new ChampionshipError(404, 'game_not_found', `${kind} game ${number} not found`);
    }

    if (game.state === 'confirmed') {
      if (game.result === body.result) {
        return {
          cycle,
          game,
          corrected: false,
          noOp: true,
          shouldEmit: false,
        };
      }

      if (!body.reason) {
        throw new ChampionshipError(
          400,
          'reason_required',
          'Correcting an already confirmed game requires a reason',
        );
      }

      const oldResult = game.result;
      const nextVersion = game.result_version + 1;
      const updatedGame = await tx.championship_games.update({
        where: { id: game.id },
        data: {
          result: body.result,
          result_version: nextVersion,
          ...(body.whitePlayer !== undefined ? { white_player: body.whitePlayer } : {}),
        },
      });

      let opportunityStatus: string | null = null;
      let hasPublishedPost = false;
      if (game.opportunity_id) {
        const opp = await tx.post_opportunities.findUnique({
          where: { id: game.opportunity_id },
          select: { status: true },
        });
        opportunityStatus = opp?.status ?? null;
        const pubCount = await tx.publications.count({
          where: {
            status: 'published',
            review_actions: { opportunity_id: game.opportunity_id },
          },
        });
        hasPublishedPost = pubCount > 0;
      }

      const label = kind === 'tiebreak' ? `Tiebreak ${number}` : `Game ${number}`;
      await openManualFlag(
        tx,
        cycleId,
        {
          kind: 'result_corrected',
          severity: 'advisory',
          autoClear: false,
          gameNumber: number,
          message: `${label} result corrected from ${oldResult} to ${body.result}: ${body.reason}`,
          detail: {
            kind,
            gameNumber: number,
            oldResult,
            newResult: body.result,
            resultVersion: nextVersion,
            reason: body.reason,
            opportunityId: game.opportunity_id,
            opportunityStatus,
            hasPublishedPost,
          },
        },
        actor,
        now,
      );

      await writeChampionshipLog(tx, {
        cycleId,
        kind: 'game_corrected',
        actor,
        message: `${label} result corrected from ${oldResult} to ${body.result} (v${nextVersion})`,
        detail: {
          kind,
          gameNumber: number,
          oldResult,
          newResult: body.result,
          resultVersion: nextVersion,
          reason: body.reason,
          opportunityId: game.opportunity_id,
          opportunityStatus,
          hasPublishedPost,
        },
        at: now,
      });

      await tx.audit_log.create({
        data: {
          actor,
          action: 'championship.correct',
          target_type: 'championship_game',
          target_id: game.id,
          details: {
            cycleId,
            kind,
            gameNumber: number,
            oldResult,
            newResult: body.result,
            resultVersion: nextVersion,
            reason: body.reason,
            attested: true,
          },
        },
      });

      return {
        cycle,
        game: updatedGame,
        corrected: true,
        noOp: false,
        shouldEmit: false,
      };
    }

    const updatedGame = await tx.championship_games.update({
      where: { id: game.id },
      data: {
        state: 'confirmed',
        result: body.result,
        confirmed_at: now,
        confirmed_by: actor,
        confirmation_basis: 'official_entry',
        ...(body.whitePlayer !== undefined ? { white_player: body.whitePlayer } : {}),
      },
    });

    const label = kind === 'tiebreak' ? `Tiebreak ${number}` : `Game ${number}`;
    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'game_confirmed',
      actor,
      message: `${label} confirmed as ${body.result} (official_entry)`,
      detail: {
        kind,
        gameNumber: number,
        result: body.result,
        basis: 'official_entry',
        observedResult: game.result,
      },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.confirm',
        target_type: 'championship_game',
        target_id: game.id,
        details: {
          cycleId,
          kind,
          gameNumber: number,
          result: body.result,
          attested: true,
        },
      },
    });

    return {
      cycle,
      game: updatedGame,
      corrected: false,
      noOp: false,
      shouldEmit: true,
    };
  });

  let emit: EmitSummary | null = null;
  let finalGame = txResult.game;
  let correctedEvents: { eventId: string; version: number }[] = [];
  if (txResult.corrected) {
    // 1.16 D6: the recorded event (and later events whose score changed) gets a new version.
    correctedEvents = await recordCorrection(
      { db: deps.db, now, logger: deps.logger },
      cycleId,
      { kind, number },
      actor,
      body.reason!,
    );
    const own = await deps.db.detected_events.findUnique({
      where: { identity_key: txResult.game.idempotency_key },
      select: { id: true, version: true },
    });
    if (own) {
      const flag = await deps.db.championship_flags.findFirst({
        where: { cycle_id: cycleId, kind: 'result_corrected', game_number: number, status: 'open' },
      });
      if (flag) {
        await deps.db.championship_flags.update({
          where: { id: flag.id },
          data: {
            detail: {
              ...(flag.detail as Record<string, unknown>),
              detectedEventId: own.id,
              eventVersion: own.version,
              recomputedEvents: correctedEvents,
            } as Prisma.InputJsonValue,
          },
        });
      }
    }
  }
  if (txResult.shouldEmit) {
    emit = await emitPendingGameEvents({ db: deps.db, now, logger: deps.logger }, cycleId);
    finalGame = await deps.db.championship_games.findUniqueOrThrow({
      where: { id: txResult.game.id },
    });
  }

  return {
    cycle: txResult.cycle,
    game: finalGame,
    corrected: txResult.corrected,
    noOp: txResult.noOp,
    emit,
    correctedEvents,
  };
}

export async function concludeCycle(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  rawBody: ConcludeCycleInput,
) {
  const body = ConcludeCycleBody.parse(rawBody);
  if (body.attested !== true) {
    throw new ChampionshipError(
      400,
      'attestation_required',
      'Concluding a championship requires attested: true',
    );
  }
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    if (cycle.phase !== 'tournament') {
      throw new ChampionshipError(
        409,
        'invalid_phase',
        `Can only conclude a championship in tournament phase (current: "${cycle.phase}")`,
      );
    }

    const updated = await tx.championship_cycles.update({
      where: { id: cycleId },
      data: {
        phase: 'post_tournament',
        confirmed_start: cycle.confirmed_start ?? now,
        confirmed_end: now,
        winner: body.winner,
      },
    });

    const autoFlags = await tx.championship_flags.findMany({
      where: { cycle_id: cycleId, status: 'open', auto_clear: true },
    });
    for (const f of autoFlags) {
      await tx.championship_flags.update({
        where: { id: f.id },
        data: {
          status: 'resolved',
          resolved_at: now,
          resolved_by: 'system',
          resolution_note: 'Cycle concluded by administrator',
        },
      });
      await writeChampionshipLog(tx, {
        cycleId,
        kind: 'flag_cleared',
        actor: 'system',
        message: `Flag "${f.kind}" cleared on conclusion`,
        detail: { flagId: f.id, flagKind: f.kind, gameNumber: f.game_number },
        at: now,
      });
    }

    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'concluded',
      actor,
      message: `Championship concluded by administrator; winner: player ${body.winner.toUpperCase()}`,
      detail: { winner: body.winner, note: body.note },
      at: now,
    });
    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'phase_changed',
      actor,
      message: 'Phase changed from tournament to post_tournament (administrator conclusion)',
      detail: { from: 'tournament', to: 'post_tournament', winner: body.winner },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.conclude',
        target_type: 'championship_cycle',
        target_id: cycleId,
        details: {
          winner: body.winner,
          note: body.note,
          attested: true,
        },
      },
    });

    return updated;
  });
}

export async function forcePhase(
  deps: ChampionshipDeps,
  actor: string,
  cycleId: string,
  rawBody: ForcePhaseInput,
) {
  const body = ForcePhaseBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    const fromPhase = cycle.phase as ChampionshipPhase;
    const toPhase = body.phase as ChampionshipPhase;

    if (toPhase === 'post_tournament' && !cycle.winner && !body.winner) {
      throw new ChampionshipError(
        400,
        'winner_required',
        'Forcing phase to post_tournament requires a winner',
      );
    }

    if (PHASE_RANK[toPhase] < PHASE_RANK[fromPhase]) {
      await tx.$executeRaw`select set_config('smb.phase_override', 'on', true)`;
    }

    const data: Prisma.championship_cyclesUpdateInput = {
      phase: toPhase,
      phase_locked: body.lock,
      phase_lock_reason: body.reason,
    };
    if (toPhase === 'pre_tournament') {
      data.confirmed_start = null;
      data.confirmed_end = null;
      data.winner = null;
    } else if (toPhase === 'tournament') {
      data.confirmed_start = cycle.confirmed_start ?? now;
      data.confirmed_end = null;
      data.winner = null;
    } else {
      data.confirmed_start = cycle.confirmed_start ?? now;
      data.confirmed_end = cycle.confirmed_end ?? now;
      data.winner = body.winner ?? cycle.winner;
    }

    const updated = await tx.championship_cycles.update({
      where: { id: cycleId },
      data,
    });

    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'forced_phase',
      actor,
      message: `Phase forced from ${fromPhase} to ${toPhase} (lock=${body.lock}): ${body.reason}`,
      detail: { from: fromPhase, to: toPhase, lock: body.lock, reason: body.reason },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.force_phase',
        target_type: 'championship_cycle',
        target_id: cycleId,
        details: {
          from: fromPhase,
          to: toPhase,
          lock: body.lock,
          reason: body.reason,
          winner: body.winner ?? null,
        },
      },
    });

    return updated;
  });
}

export async function unlockCycle(deps: ChampionshipDeps, actor: string, cycleId: string) {
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const cycle = await tx.championship_cycles.findUnique({ where: { id: cycleId } });
    if (!cycle) {
      throw new ChampionshipError(404, 'not_found', 'Championship cycle not found');
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + cycle.cycle_key}))`;

    const updated = await tx.championship_cycles.update({
      where: { id: cycleId },
      data: { phase_locked: false },
    });

    await writeChampionshipLog(tx, {
      cycleId,
      kind: 'unlocked',
      actor,
      message: 'Phase lock removed by administrator',
      detail: { phase: cycle.phase },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.unlock',
        target_type: 'championship_cycle',
        target_id: cycleId,
        details: { phase: cycle.phase },
      },
    });

    return updated;
  });
}

export async function resolveFlag(
  deps: ChampionshipDeps,
  actor: string,
  flagId: string,
  rawBody: ResolveFlagInput,
  cycleId?: string,
) {
  const body = ResolveFlagBody.parse(rawBody);
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const flag = await tx.championship_flags.findUnique({
      where: { id: flagId },
      include: { championship_cycles: { select: { id: true, cycle_key: true } } },
    });
    if (!flag || (cycleId && flag.cycle_id !== cycleId)) {
      throw new ChampionshipError(404, 'flag_not_found', 'Championship flag not found');
    }

    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${'smb.championship:' + flag.championship_cycles.cycle_key}))`;

    if (flag.auto_clear) {
      throw new ChampionshipError(
        400,
        'auto_clear_flag',
        `Flag "${flag.kind}" is auto-clearing and cannot be resolved manually`,
      );
    }
    if (flag.status === 'resolved') {
      throw new ChampionshipError(409, 'already_resolved', 'Flag is already resolved');
    }

    const updated = await tx.championship_flags.update({
      where: { id: flagId },
      data: {
        status: 'resolved',
        resolved_at: now,
        resolved_by: actor,
        resolution_note: body.note,
      },
    });

    await writeChampionshipLog(tx, {
      cycleId: flag.cycle_id,
      kind: 'flag_resolved',
      actor,
      message: `Flag "${flag.kind}" resolved: ${body.note}`,
      detail: {
        flagId,
        flagKind: flag.kind,
        gameNumber: flag.game_number,
        note: body.note,
      },
      at: now,
    });

    await tx.audit_log.create({
      data: {
        actor,
        action: 'championship.resolve_flag',
        target_type: 'championship_flag',
        target_id: flagId,
        details: {
          cycleId: flag.cycle_id,
          flagKind: flag.kind,
          gameNumber: flag.game_number,
          note: body.note,
        },
      },
    });

    return updated;
  });
}
