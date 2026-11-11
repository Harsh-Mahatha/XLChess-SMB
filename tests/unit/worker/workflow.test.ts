import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWorkflow,
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
