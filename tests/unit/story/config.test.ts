/* eslint-disable @typescript-eslint/no-explicit-any -- the test edits raw JSON */
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../packages/shared/src/index.js';
import {
  buildConfigSet,
  readConfigDir,
  type RawConfigFiles,
} from '../../../apps/api/src/config/loader.js';

const raw = () => structuredClone(readConfigDir()) as RawConfigFiles & { postTypes: any[] };

function issues(r: RawConfigFiles): string {
  try {
    buildConfigSet(r);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.join('\n');
    throw err;
  }
  return '';
}

describe('storySelection config', () => {
  it('is optional: the shipped config validates without it', () => {
    expect(issues(raw())).toBe('');
  });

  it('accepts known angles, weights and a minimum score', () => {
    const r = raw();
    r.postTypes[0].json.storySelection = {
      angles: ['game_result', 'match_standing'],
      minScore: 0.4,
      weights: { novelty: 0.5 },
    };
    expect(issues(r)).toBe('');
  });

  it('rejects an unknown angle id', () => {
    const r = raw();
    r.postTypes[0].json.storySelection = { angles: ['game_result', 'made_up'] };
    expect(issues(r)).toContain('unknown angle "made_up"');
  });

  it('rejects weights that are all zero', () => {
    const r = raw();
    r.postTypes[0].json.storySelection = {
      weights: { significance: 0, timeliness: 0, novelty: 0, relevance: 0, channel: 0 },
    };
    expect(issues(r)).toContain('at least one weight must be above 0');
  });

  it('rejects unknown keys and out-of-range values', () => {
    const r = raw();
    r.postTypes[0].json.storySelection = { minScore: 2, extra: true };
    const text = issues(r);
    expect(text).toContain('storySelection');
  });
});
