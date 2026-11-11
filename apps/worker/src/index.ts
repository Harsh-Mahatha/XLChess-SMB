import { GPU_JOB_KINDS } from '@smb/shared';
import { DEFAULT_CONFIG_PATH, derivePaths, loadConfig } from './config.js';
import { NvidiaSmiMonitor } from './gpu.js';
import { startHealthLoop } from './health.js';
import { log } from './log.js';
import { ComfyRuntime, loadWorkflowTemplate } from './runtimes/comfy.js';
import { OllamaRuntime } from './runtimes/ollama.js';
import { formatSelfTestReport, runLocalSelfTest } from './selftest.js';
import { GpuStageRunner } from './stages.js';
import { join } from 'node:path';

/** Replaced with the package version by the bundler (see `npm run bundle`). */
declare const __WORKER_VERSION__: string | undefined;
export const WORKER_VERSION = typeof __WORKER_VERSION__ === 'string' ? __WORKER_VERSION__ : 'dev';

interface Args {
  version: boolean;
  selftestLocal: boolean;
  json: boolean;
  configPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    version: false,
    selftestLocal: false,
    json: false,
    configPath: process.env.XLW_CONFIG ?? DEFAULT_CONFIG_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = true;
    else if (a === '--selftest-local') args.selftestLocal = true;
    else if (a === '--json') args.json = true;
    else if (a === '--config') args.configPath = argv[++i] ?? args.configPath;
  }
  return args;
}

function build(configPath: string) {
  const cfg = loadConfig(configPath);
  const paths = derivePaths(cfg);
  const gpu = new NvidiaSmiMonitor();
  const llm = new OllamaRuntime(cfg, paths);
  const image = new ComfyRuntime(cfg, paths);
  const runner = new GpuStageRunner({ llm, image, gpu, requireGpu: true });
  return { cfg, paths, gpu, llm, image, runner };
}

async function runSelfTest(args: Args): Promise<number> {
  const { paths, gpu, llm, runner } = build(args.configPath);
  const template = loadWorkflowTemplate(join(paths.workflows, 'z-image-turbo.json'));
  let report;
  try {
    report = await runLocalSelfTest({ runner, gpu, template, comfyModelsDir: paths.comfyModels });
  } finally {
    await llm.stop();
  }
  process.stdout.write(`${args.json ? JSON.stringify(report) : formatSelfTestReport(report)}\n`);
  return report.ok ? 0 : 1;
}

/**
 * Service mode. Today it keeps the local runtimes healthy and writes health.json for the watchdog.
 * Pairing and claiming jobs from the SMB API are added with the worker protocol (docs/installer-v1-plan.md section 9).
 */
async function runService(args: Args): Promise<void> {
  const { cfg, paths, gpu, llm, runner } = build(args.configPath);
  const startedAt = new Date().toISOString();
  log('info', 'worker starting', {
    version: WORKER_VERSION,
    jobKinds: [...GPU_JOB_KINDS],
    dataDir: cfg.dataDir,
  });

  const stopHealth = startHealthLoop(paths.health, {
    version: WORKER_VERSION,
    startedAt,
    runner,
    gpu,
    ollamaUp: () => llm.isUp(),
  });

  await llm
    .ensureRunning()
    .catch((err) => log('error', 'ollama failed to start', { error: String(err) }));
  const supervisor = setInterval(() => {
    void llm
      .isUp()
      .then((up) => (up ? undefined : llm.ensureRunning()))
      .catch((err) => log('error', 'ollama restart failed', { error: String(err) }));
  }, 15_000);

  const shutdown = (signal: string): void => {
    log('info', 'worker stopping', { signal });
    clearInterval(supervisor);
    stopHealth();
    void llm.stop().finally(() => process.exit(0));
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => shutdown(s));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`${WORKER_VERSION}\n`);
    return;
  }
  if (args.selftestLocal) {
    process.exitCode = await runSelfTest(args);
    return;
  }
  await runService(args);
}

main().catch((err) => {
  log('error', 'worker crashed', {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(1);
});
