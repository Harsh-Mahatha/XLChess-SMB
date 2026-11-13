import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTextOnlyWorkflow,
  buildWorkflow,
  WorkflowNotAllowedError,
  workflowFingerprint,
  requiredModelFiles,
  type Workflow,
} from '../../../apps/worker/src/runtimes/workflow.js';

const template = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../apps/worker/workflows/z-image-turbo.json'),
    'utf8',
  ),
) as Workflow;

const params = {
  prompt: 'a chess board',
  seed: 42,
  width: 1024,
  height: 768,
  filenamePrefix: 'job1',
};

describe('buildWorkflow', () => {
  it('fills the prompt, seed, size and file prefix', () => {
    const wf = buildWorkflow(template, params);
    expect(wf['4']?.inputs.text).toBe('a chess board');
    expect(wf['8']?.inputs.seed).toBe(42);
    expect(wf['6']?.inputs).toMatchObject({ width: 1024, height: 768, batch_size: 1 });
    expect(wf['10']?.inputs.filename_prefix).toBe('job1');
  });

  it('never changes the template', () => {
    const before = JSON.stringify(template);
    buildWorkflow(template, params);
    expect(JSON.stringify(template)).toBe(before);
  });

  it('keeps the Z-Image-Turbo settings: 8 steps, CFG 1, zeroed negative prompt', () => {
    const wf = buildWorkflow(template, params);
    expect(wf['8']?.inputs).toMatchObject({ steps: 8, cfg: 1, denoise: 1 });
    expect(wf['5']?.class_type).toBe('ConditioningZeroOut');
  });

  it('rejects an empty prompt and bad sizes', () => {
    expect(() => buildWorkflow(template, { ...params, prompt: '  ' })).toThrow(/empty/);
    expect(() => buildWorkflow(template, { ...params, width: 1000 })).toThrow(/multiples of 16/);
    expect(() => buildWorkflow(template, { ...params, height: 4096 })).toThrow(
      /between 256 and 2048/,
    );
    expect(() => buildWorkflow(template, { ...params, width: 512.5 })).toThrow(/whole numbers/);
  });

  it('fails clearly when the template lacks a titled node', () => {
    const broken = structuredClone(template);
    delete broken['4'];
    expect(() => buildWorkflow(broken, params)).toThrow(/positive_prompt/);
  });
});

describe('requiredModelFiles', () => {
  it('lists the three files the installer downloads, in the folders ComfyUI expects', () => {
    expect(requiredModelFiles(template)).toEqual([
      { folder: 'diffusion_models', file: 'z_image_turbo_bf16.safetensors' },
      { folder: 'text_encoders', file: 'qwen_3_4b.safetensors' },
      { folder: 'vae', file: 'ae.safetensors' },
    ]);
  });
});

describe('assertTextOnlyWorkflow (a real photograph can never be an input)', () => {
  const withNode = (id: string, class_type: string, inputs: Record<string, unknown> = {}) => {
    const wf = structuredClone(template);
    wf[id] = { class_type, inputs };
    return wf;
  };

  it('accepts the repo workflow', () => {
    expect(() => assertTextOnlyWorkflow(template)).not.toThrow();
  });

  it.each([
    'LoadImage',
    'LoadImageMask',
    'VAEEncode',
    'VAEEncodeForInpaint',
    'ImageScale',
    'ControlNetApply',
    'IPAdapter',
  ])('refuses a %s node', (type) => {
    expect(() => assertTextOnlyWorkflow(withNode('99', type))).toThrow(WorkflowNotAllowedError);
    expect(() => buildWorkflow(withNode('99', type), params)).toThrow(/only text-to-image nodes/);
  });

  it('refuses a sampler that does not start from the empty latent', () => {
    const wf = structuredClone(template);
    wf['8']!.inputs.latent_image = ['4', 0];
    expect(() => assertTextOnlyWorkflow(wf)).toThrow(/empty latent/);
  });

  it('refuses partial denoise, which would keep part of an input', () => {
    const wf = structuredClone(template);
    wf['8']!.inputs.denoise = 0.6;
    expect(() => assertTextOnlyWorkflow(wf)).toThrow(/full denoise/);
  });

  it('fingerprints a workflow independently of key order', () => {
    const reordered = Object.fromEntries(Object.entries(template).reverse()) as Workflow;
    expect(workflowFingerprint(reordered)).toBe(workflowFingerprint(template));
    expect(workflowFingerprint(withNode('99', 'SaveImage'))).not.toBe(
      workflowFingerprint(template),
    );
  });
});
