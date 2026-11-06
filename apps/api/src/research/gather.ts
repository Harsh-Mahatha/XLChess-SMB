import type {
  ChessEvent,
  ChessGame,
  PackageSummary,
  ResearchSubject,
  SourceFailure,
  Sourced,
} from '@smb/shared';
import { SourceError } from '../sources/errors.js';
import type { SourceGateway } from '../sources/gateway.js';

export interface Gathered {
  events: Sourced<ChessEvent>[];
  games: Sourced<ChessGame>[];
  failures: SourceFailure[];
  skipped: PackageSummary['skippedSources'];
  attempted: number;
  succeeded: number;
  retrievedAt: string[];
}

/**
 * Retrieves what the subject needs from each source the post type lists, through the gateway only.
 * A source that is not approved, or that has no reference for this event, is skipped and said so.
 * A source that fails is recorded as a failure. Nothing is substituted for data that did not arrive.
 */
export async function gather(
  gateway: SourceGateway,
  sourceIds: string[],
  subject: ResearchSubject,
): Promise<Gathered> {
  const out: Gathered = {
    events: [],
    games: [],
    failures: [],
    skipped: [],
    attempted: 0,
    succeeded: 0,
    retrievedAt: [],
  };

  async function call<T>(
    sourceId: string,
    capability: string,
    run: () => Promise<{ items: Sourced<T>[] }>,
  ): Promise<Sourced<T>[]> {
    out.attempted++;
    try {
      const res = await run();
      out.succeeded++;
      out.retrievedAt.push(...res.items.map((i) => i.provenance.retrievedAt));
      return res.items;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      out.failures.push({ sourceId, capability, code: err.code, message: err.message });
      return [];
    }
  }

  for (const sourceId of sourceIds) {
    const caps = gateway.capabilitiesOf(sourceId);
    if (caps.length === 0) {
      out.skipped.push({ sourceId, reason: 'not approved for automated retrieval' });
      continue;
    }
    const ref = subject.eventRefs[sourceId];
    if (!ref) {
      out.skipped.push({ sourceId, reason: 'no event reference for this source' });
      continue;
    }
    if (caps.includes('events')) {
      out.events.push(
        ...(await call(sourceId, 'events', () =>
          gateway.fetch(sourceId, 'events', { externalId: ref }),
        )),
      );
    }
    if (caps.includes('games')) {
      out.games.push(
        ...(await call(sourceId, 'games', () =>
          gateway.fetch(sourceId, 'games', { eventExternalId: ref }),
        )),
      );
    }
  }
  return out;
}
