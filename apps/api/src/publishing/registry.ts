import type { Channel, PublishMode } from '@smb/shared';
import { DryRunPublisher } from './x/dry-run.js';
import { XPublisher } from './x/adapter.js';
import { PublishError, type SocialPublisher } from './types.js';

export interface PublisherDeps {
  x?: XPublisher;
}

export function publisherFor(
  mode: PublishMode,
  channel: Channel,
  deps: PublisherDeps,
): SocialPublisher {
  if (channel !== 'x') {
    throw new PublishError(
      'permanent',
      'channel_not_supported',
      `Channel '${channel}' is not supported in this version`,
    );
  }

  if (mode === 'dry_run') {
    return new DryRunPublisher();
  }

  if (mode === 'sandbox' || mode === 'live') {
    if (!deps.x) {
      throw new PublishError(
        'permanent',
        'not_configured',
        `X publisher is not configured for mode '${mode}'`,
      );
    }
    return deps.x;
  }

  throw new PublishError('permanent', 'invalid_mode', `Unsupported publish mode: ${mode}`);
}
