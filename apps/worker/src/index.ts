import { readFileSync } from 'node:fs';
import { GPU_JOB_KINDS } from '@smb/shared';
import { WorkerApiClient } from './api-client.js';
import { DEFAULT_CONFIG_PATH, derivePaths, loadConfig } from './config.js';
import { NvidiaSmiMonitor } from './gpu.js';
import { startHealthLoop } from './health.js';
import { startHeartbeat } from './heartbeat.js';
import { pairWithServer, type PairingResult } from './pairing.js';
import { readDeviceToken } from './token.js';
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
  pair: boolean;
  json: boolean;
  configPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    version: false,
    selftestLocal: false,
    pair: false,
    json: false,
    configPath: process.env.XLW_CONFIG ?? DEFAULT_CONFIG_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = true;
    else if (a === '--selftest-local') args.selftestLocal = true;
    else if (a === '--pair') args.pair = true;
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
 * `--pair`: the installer pipes the pairing code to stdin (never on the command line, where other programs
 * could see it). The last line printed is a JSON result; on success it carries the device token, which the
 * installer encrypts straight away.
 */
async function runPair(args: Args): Promise<number> {
  const { cfg, gpu } = build(args.configPath);
  const emit = (result: PairingResult): void => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  };
  const code = readFileSync(0, 'utf8').trim();
  if (!cfg.apiUrl) {
    emit({ ok: false, error: 'no_api_url', message: 'config.json has no apiUrl' });
    return 1;
  }
  if (!code) {
    emit({ ok: false, error: 'no_code', message: 'no pairing code was given' });
    return 1;
  }
  const result = await pairWithServer({
    apiUrl: cfg.apiUrl,
    pairingCode: code,
    version: WORKER_VERSION,
    gpu,
  });
  emit(result);
  return result.ok ? 0 : 1;
}

/**
 * Service mode. Keeps the local runtimes healthy, writes health.json for the watchdog and, once the PC is
 * paired, reports status to the SMB API. Claiming jobs is added with the job runner (module 1.17).
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

  let stopHeartbeat = (): void => undefined;
  const token = await readDeviceToken(paths.tokenFile);
  if (cfg.apiUrl && token) {
    stopHeartbeat = startHeartbeat({
      client: new WorkerApiClient({ baseUrl: cfg.apiUrl, token }),
      version: WORKER_VERSION,
      startedAt,
      runner,
      gpu,
      ollamaUp: () => llm.isUp(),
      dataDir: cfg.dataDir,
    });
  } else {
    log('warn', 'this PC is not paired with the SMB API yet; running locally only', {
      hasApiUrl: Boolean(cfg.apiUrl),
      hasToken: Boolean(token),
    });
  }

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
    stopHeartbeat();
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
  if (args.pair) {
    process.exitCode = await runPair(args);
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
