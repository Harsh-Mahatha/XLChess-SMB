import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { derivePaths, loadConfig } from '../../../apps/worker/src/config.js';

const dirs: string[] = [];
function write(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'xlw-'));
  dirs.push(d);
  const f = join(d, 'config.json');
  writeFileSync(f, contents);
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads a minimal config and fills defaults', () => {
    const cfg = loadConfig(
      write(JSON.stringify({ schemaVersion: 1, programDir: 'C:\\P', dataDir: 'C:\\D' })),
    );
    expect(cfg.ollama).toEqual({ port: 11434, model: 'qwen3.5:9b', numCtx: 16384 });
    expect(cfg.comfy.port).toBe(8188);
  });

  it('accepts a file that starts with a byte-order mark', () => {
    const cfg = loadConfig(
      write('\uFEFF' + JSON.stringify({ schemaVersion: 1, programDir: 'C:\\P', dataDir: 'C:\\D' })),
    );
    expect(cfg.dataDir).toBe('C:\\D');
  });

  it('names the bad field', () => {
    expect(() =>
      loadConfig(write(JSON.stringify({ schemaVersion: 1, programDir: 'C:\\P' }))),
    ).toThrow(/dataDir/);
  });

  it('says so when the file is missing', () => {
    expect(() => loadConfig('Z:\\nope\\config.json')).toThrow(/cannot read worker config/);
  });
});

describe('derivePaths', () => {
  it('matches the folder layout the installer creates', () => {
    const cfg = loadConfig(
      write(
        JSON.stringify({
          schemaVersion: 1,
          programDir: 'C:\\Program Files\\XLChessWorker',
          dataDir: 'C:\\ProgramData\\XLChessWorker',
        }),
      ),
    );
    const p = derivePaths(cfg);
    expect(p.ollamaExe).toBe('C:\\Program Files\\XLChessWorker\\ollama\\ollama.exe');
    expect(p.ollamaModels).toBe('C:\\ProgramData\\XLChessWorker\\models\\ollama');
    expect(p.comfyMain).toBe('C:\\ProgramData\\XLChessWorker\\comfyui\\ComfyUI\\main.py');
    expect(p.workflows).toBe('C:\\Program Files\\XLChessWorker\\worker\\workflows');
    expect(p.health).toBe('C:\\ProgramData\\XLChessWorker\\state\\health.json');
  });
});
