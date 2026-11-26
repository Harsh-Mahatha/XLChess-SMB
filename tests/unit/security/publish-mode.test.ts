import { describe, expect, it } from 'vitest';
import type { PublishMode } from '@smb/shared';
import {
  isModeAllowed,
  publishRank,
  resolveEffectivePublishMode,
} from '../../../apps/api/src/publishing/mode.js';

const MODES: PublishMode[] = ['dry_run', 'sandbox', 'live'];
const DEPLOYMENTS = ['development', 'staging', 'production'] as const;

describe('publish mode resolution', () => {
  it('orders ranks dry_run < sandbox < live', () => {
    expect(publishRank('dry_run')).toBeLessThan(publishRank('sandbox'));
    expect(publishRank('sandbox')).toBeLessThan(publishRank('live'));
  });

  it('resolves every combination of setting, ceiling, allowLive and deployment', () => {
    for (const setting of MODES) {
      for (const ceiling of MODES) {
        for (const allowLive of [false, true]) {
          for (const deployment of DEPLOYMENTS) {
            const actual = resolveEffectivePublishMode(setting, {
              SMB_PUBLISH_MODE: ceiling,
              SMB_ALLOW_LIVE_PUBLISH: allowLive,
              SMB_DEPLOYMENT: deployment,
            });
            const lower = publishRank(setting) <= publishRank(ceiling) ? setting : ceiling;
            const liveAllowed = ceiling === 'live' && allowLive && deployment === 'production';
            const expected: PublishMode = lower === 'live' && !liveAllowed ? 'sandbox' : lower;
            expect(actual).toBe(expected);
          }
        }
      }
    }
  });

  it('checks isModeAllowed across all pairs of effective x row mode', () => {
    const expected: Record<PublishMode, Record<PublishMode, boolean>> = {
      dry_run: { dry_run: true, sandbox: false, live: false },
      sandbox: { dry_run: true, sandbox: true, live: false },
      live: { dry_run: true, sandbox: true, live: true },
    };
    for (const effective of MODES) {
      for (const rowMode of MODES) {
        expect(isModeAllowed(effective, rowMode)).toBe(expected[effective][rowMode]);
      }
    }
  });
});
