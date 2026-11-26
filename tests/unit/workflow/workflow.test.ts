import { describe, expect, it } from 'vitest';
import {
  AiError,
  JOB_LANE_OF,
  GPU_JOB_KINDS,
  SERVER_JOB_KINDS,
  type TemplateManifest,
} from '@smb/shared';
import { JobError, classifyError } from '../../../apps/api/src/jobs/errors.js';
import { backoffSeconds, nextRetryKey } from '../../../apps/api/src/jobs/queue.js';
import { GraphicError } from '../../../apps/api/src/graphics/text.js';
import { buildRenderData } from '../../../apps/api/src/workflow/render-data.js';
import { IN_PROCESS_GPU_KINDS } from '../../../apps/api/src/workflow/runner.js';
import { STEP_OF_KIND } from '../../../apps/api/src/workflow/types.js';
import type { ChosenPhoto } from '../../../apps/api/src/images/index.js';

describe('error classification', () => {
  it('keeps the retryable flag a step chose', () => {
    expect(classifyError(new JobError('sources_failed', 'down', true))).toMatchObject({
      retryable: true,
    });
    expect(classifyError(new JobError('bad_payload', 'no id', false))).toMatchObject({
      retryable: false,
    });
  });

  it('retries a model that timed out and gives up on one that returned invalid output', () => {
    expect(classifyError(new AiError('timeout', 'slow', true))).toMatchObject({
      code: 'ai_timeout',
      retryable: true,
    });
    expect(classifyError(new AiError('invalid_output', 'bad', false))).toMatchObject({
      retryable: false,
    });
  });

  it('retries research that is not ready yet but not a gate that will keep saying no', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    expect(classifyError(named('ResearchNotReadyError')).retryable).toBe(true);
    expect(classifyError(named('StoryNotReadyError')).retryable).toBe(false);
    expect(classifyError(named('GenerationNotReadyError')).retryable).toBe(false);
  });

  it('stops on a graphic error and retries anything unknown (attempts are bounded)', () => {
    expect(classifyError(new GraphicError('verification_failed', 'photo changed'))).toMatchObject({
      code: 'graphic_verification_failed',
      retryable: false,
    });
    expect(classifyError(new Error('socket hang up'))).toMatchObject({
      code: 'unexpected',
      retryable: true,
    });
    expect(classifyError('a string')).toMatchObject({ retryable: true });
  });
});

describe('retry timing and keys', () => {
  const policy = { backoffSeconds: 60, backoffMultiplier: 2 };
  it('doubles the delay after each attempt', () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(n, policy))).toEqual([60, 120, 240, 480]);
  });
  it('numbers retries of the same step #1, #2, ...', () => {
    expect(nextRetryKey('render:c:r')).toBe('render:c:r#1');
    expect(nextRetryKey('render:c:r#1')).toBe('render:c:r#2');
    expect(nextRetryKey('render:c:r#9')).toBe('render:c:r#10');
  });
});

describe('job kinds', () => {
  it('has a lane for every kind and no kind in both lanes', () => {
    for (const k of [...SERVER_JOB_KINDS, ...GPU_JOB_KINDS]) expect(JOB_LANE_OF[k]).toBeDefined();
    expect(
      SERVER_JOB_KINDS.filter((k) => (GPU_JOB_KINDS as readonly string[]).includes(k)),
    ).toEqual([]);
    expect(JOB_LANE_OF.story_select).toBe('server');
    expect(JOB_LANE_OF.candidates_generate).toBe('gpu');
    expect(IN_PROCESS_GPU_KINDS).not.toContain('worker_selftest');
  });
  it('maps every pipeline job to the step a retry returns to, and leaves review and housekeeping jobs out', () => {
    expect(STEP_OF_KIND.research_build).toBe('researching');
    expect(STEP_OF_KIND.graphics_render).toBe('generating');
    expect(STEP_OF_KIND.revision_from_feedback).toBeUndefined();
    expect(STEP_OF_KIND.assets_purge).toBeUndefined();
  });
});

describe('buildRenderData', () => {
  const template = { id: 'player-vs-player' } as TemplateManifest;
  const claims = [
    {
      claimKey: 'game.result',
      value: { result: '1-0', white: 'Gukesh, D', black: 'Sindarov J', round: '3' },
    },
    { claimKey: 'event.name', value: 'World Championship 2026' },
  ];
  const photo = (name: string, assetId: string): ChosenPhoto =>
    ({
      assetId,
      subject: { role: 'player', name },
      attributionText: 'Photo by Someone, CC BY-SA 4.0',
    }) as ChosenPhoto;

  it('draws names, result and event from the verified claims only', () => {
    const r = buildRenderData(template, claims, []);
    expect(r).toMatchObject({ mapped: true, photoSlots: [] });
    if (!r.mapped) return;
    expect(r.data.texts).toMatchObject({
      player_a: 'Gukesh, D',
      player_b: 'Sindarov J',
      result: '1-0',
      subtitle: 'World Championship 2026 · Round 3',
      initials_a: 'GD',
      initials_b: 'SJ',
    });
    expect(r.data.flags).toBeUndefined();
  });

  it("puts each player's photograph in their own slot, matched on surname, with its credit", () => {
    const r = buildRenderData(template, claims, [
      photo('Jonas Sindarov', 'asset-b'),
      photo('Dommaraju Gukesh', 'asset-x'),
    ]);
    if (!r.mapped) throw new Error('not mapped');
    // "Gukesh, D" has the surname Gukesh; "Dommaraju Gukesh" ends in Gukesh too.
    expect(r.data.photos).toMatchObject({
      photo_a: { assetId: 'asset-x', credit: 'Photo by Someone, CC BY-SA 4.0' },
      photo_b: { assetId: 'asset-b' },
    });
    expect(r.photoSlots.sort()).toEqual(['photo_a', 'photo_b']);
  });

  it('refuses to guess: no game result, or an unmapped template, means no graphic', () => {
    expect(buildRenderData(template, [], [])).toMatchObject({ mapped: false });
    expect(
      buildRenderData({ id: 'tournament-result' } as TemplateManifest, claims, []),
    ).toMatchObject({
      mapped: false,
      reason: expect.stringContaining('no data mapping'),
    });
  });
});
