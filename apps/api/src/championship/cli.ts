/* eslint-disable no-console -- command-line tool */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { matchScore } from '@smb/shared';
import { loadConfigSet } from '../config/loader.js';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { PrismaSourceRecordStore, createSourceGateway } from '../sources/index.js';
import { registerCycle } from './service.js';
import { DetectorRegistry, runEventPoll } from '../events/index.js';
import { championshipDetector } from './detector.js';
import { CHAMPIONSHIP_DETECTOR_ID } from './emit.js';
import { RegisterCycleBody } from './types.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean', default: false },
    file: { type: 'string' },
    now: { type: 'string' },
  },
});

const command = positionals[0] ?? 'status';
const env = loadEnv();
const logger = createLogger(env);
const db = await getDb();

try {
  if (command === 'status') {
    const cycle = await db.championship_cycles.findFirst({
      where: { post_type_id: '1.1', is_current: true },
    });
    if (!cycle) {
      console.log('No current championship cycle registered.');
    } else {
      const games = await db.championship_games.findMany({
        where: { cycle_id: cycle.id },
        orderBy: [{ kind: 'asc' }, { game_number: 'asc' }],
      });
      const openFlags = await db.championship_flags.findMany({
        where: { cycle_id: cycle.id, status: 'open' },
        orderBy: { opened_at: 'asc' },
      });
      const score = matchScore(
        games.map((g) => ({
          kind: g.kind as 'classical' | 'tiebreak',
          state: g.state as 'scheduled' | 'in_progress' | 'result_observed' | 'confirmed',
          result: g.result as '1-0' | '0-1' | '1/2-1/2' | null,
          whitePlayer: g.white_player as 'a' | 'b' | null,
        })),
        'classical',
      );
      console.log(`Cycle: ${cycle.title} (${cycle.cycle_key})`);
      console.log(
        `Phase: ${cycle.phase}${cycle.phase_locked ? ` [LOCKED: ${cycle.phase_lock_reason ?? 'yes'}]` : ''}`,
      );
      console.log(
        `Score (confirmed classical): A ${score.a} - ${score.b} B (${score.confirmed}/${cycle.total_games} confirmed)`,
      );
      console.log(
        `Next round: ${cycle.next_round_at?.toISOString() ?? '-'}${cycle.any_round_live ? ' (a round is live)' : ''}`,
      );
      console.log(
        `Last sync: ${cycle.last_synced_at?.toISOString() ?? '-'} (${cycle.last_sync_status ?? '-'})`,
      );
      console.log(`\nGames (${games.length}):`);
      console.table(
        games.map((g) => ({
          kind: g.kind,
          no: g.game_number,
          state: g.state,
          white: g.white_player ?? '-',
          observed: g.state === 'result_observed' ? g.result : '-',
          confirmed: g.state === 'confirmed' ? g.result : '-',
          basis: g.confirmation_basis ?? '-',
          postStatus: g.post_status,
        })),
      );
      console.log(`\nOpen Flags (${openFlags.length}):`);
      if (openFlags.length > 0) {
        console.table(
          openFlags.map((f) => ({
            id: f.id,
            kind: f.kind,
            severity: f.severity,
            autoClear: f.auto_clear,
            game: f.game_number ?? '-',
            message: f.message,
          })),
        );
      } else {
        console.log('None.');
      }
    }
  } else if (command === 'sync') {
    const configSet = loadConfigSet();
    const gateway = createSourceGateway(configSet.sources, new PrismaSourceRecordStore(db));
    const now = values.now ? new Date(values.now) : undefined;
    // 1.16: through the events poller, so the lease and poller health apply to manual runs too.
    const detectors = new DetectorRegistry().register(
      championshipDetector({
        db,
        gateway,
        registry: configSet.sources,
        logger,
        stabilitySeconds: env.SMB_EVENTS_STABILITY_SECONDS,
      }),
    );
    const poll = await runEventPoll(
      { db, detectors, logger },
      { force: values.force, now, only: CHAMPIONSHIP_DETECTOR_ID },
    );
    console.log(JSON.stringify(poll.detectors[0], null, 2));
  } else if (command === 'register') {
    if (!values.file) {
      console.error('Usage: championship:register --file <path-to-json>');
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(values.file, 'utf8'));
    const body = RegisterCycleBody.parse(raw);
    const created = await registerCycle({ db, logger }, 'cli', body);
    console.log(
      JSON.stringify(
        {
          id: created.cycle.id,
          cycleKey: created.cycle.cycle_key,
          phase: created.cycle.phase,
          gamesCreated: created.games.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`Unknown command "${command}". Available: status, sync, register.`);
    process.exit(1);
  }
} finally {
  await db.$disconnect();
}
