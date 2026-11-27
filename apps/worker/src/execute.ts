import {
  meterProvider,
  runGeneration,
  runRevision,
  type AiProvider,
  type ClaimedJob,
  type GenerationInput,
  type JobUsage,
  type RevisionRequest,
} from '@smb/shared';
import type { GpuMonitor } from './gpu.js';
import type { Workflow } from './runtimes/workflow.js';
import { runLocalSelfTest } from './selftest.js';
import type { GpuStageRunner } from './stages.js';

export interface ExecuteDeps {
  runner: GpuStageRunner;
  gpu: GpuMonitor;
  template: Workflow;
  comfyModelsDir: string;
  /** Optional override for tests; defaults to the runtime's OllamaProvider. */
  provider?: AiProvider;
}

export interface ExecutedJob {
  value: unknown;
  durationMs: number;
  usage?: JobUsage;
}

function withUsage(
  stage: { value: unknown; durationMs: number },
  meter: ReturnType<typeof meterProvider> | undefined,
): ExecutedJob {
  // The stage time is how long the GPU was held, model loading and unloading included.
  return {
    value: stage.value,
    durationMs: stage.durationMs,
    usage: { ...(meter?.usage() ?? {}), gpuMs: stage.durationMs },
  };
}

/** Runs one claimed GPU job locally, releasing VRAM after the stage finishes. */
export async function executeJob(deps: ExecuteDeps, job: ClaimedJob): Promise<ExecutedJob> {
  if (job.kind === 'candidates_generate') {
    let meter: ReturnType<typeof meterProvider> | undefined;
    const stage = await deps.runner.runLlmStage((llm) => {
      meter = meterProvider(deps.provider ?? llm.provider());
      return runGeneration(meter.provider, job.input as GenerationInput);
    });
    return withUsage(stage, meter);
  }

  if (job.kind === 'revision_from_feedback') {
    let meter: ReturnType<typeof meterProvider> | undefined;
    const stage = await deps.runner.runLlmStage((llm) => {
      meter = meterProvider(deps.provider ?? llm.provider());
      return runRevision(
        meter.provider,
        job.input as GenerationInput,
        job.request as RevisionRequest,
      );
    });
    return withUsage(stage, meter);
  }

  if (job.kind === 'worker_selftest') {
    const report = await runLocalSelfTest({
      runner: deps.runner,
      gpu: deps.gpu,
      template: deps.template,
      comfyModelsDir: deps.comfyModelsDir,
    });
    return { value: report, durationMs: report.durationMs };
  }

  throw new Error(`unsupported job kind ${(job as { kind: string }).kind}`);
}
