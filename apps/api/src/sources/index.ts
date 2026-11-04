import type { SourcesRegistry } from '@smb/shared';
import { SourceGateway } from './gateway.js';
import { lichessAdapter } from './lichess/adapter.js';
import type { SourceRecordStore } from './store.js';
import type { ChessDataSource } from './types.js';

export * from './errors.js';
export * from './gateway.js';
export * from './store.js';
export * from './types.js';
export { lichessAdapter } from './lichess/adapter.js';

/** Every adapter that exists in code. Registering one here is not enough: config/sources.json must also approve it. */
export const ADAPTERS: ChessDataSource[] = [lichessAdapter];

export const USER_AGENT = 'XLChess-SMB/0.1 (chess news research bot)';

export function createSourceGateway(
  registry: SourcesRegistry,
  store: SourceRecordStore,
  extra: Partial<ConstructorParameters<typeof SourceGateway>[0]> = {},
): SourceGateway {
  return new SourceGateway({
    registry,
    adapters: ADAPTERS,
    store,
    userAgent: USER_AGENT,
    ...extra,
  });
}
