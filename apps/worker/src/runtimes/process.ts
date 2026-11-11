import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';

export interface ManagedProcessOptions {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Combined stdout/stderr of the child is appended here. */
  logFile: string;
}

/**
 * A child process the worker owns. It never outlives the worker: `stop()` kills the whole process tree
 * (Ollama and ComfyUI both start helper processes that hold GPU memory).
 */
export class ManagedProcess {
  private child: ChildProcess | undefined;
  private logStream: WriteStream | undefined;
  private exitCode: number | null | undefined;

  constructor(private readonly options: ManagedProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined && this.exitCode === undefined;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.running) return;
    mkdirSync(dirname(this.options.logFile), { recursive: true });
    this.logStream = createWriteStream(this.options.logFile, { flags: 'a' });
    this.exitCode = undefined;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.pipe(this.logStream, { end: false });
    child.stderr?.pipe(this.logStream, { end: false });
    child.on('error', (err) => {
      log('error', `${this.options.name} failed to start`, { error: String(err) });
      this.exitCode = null;
    });
    child.on('exit', (code, signal) => {
      this.exitCode = code ?? null;
      log(code === 0 ? 'info' : 'warn', `${this.options.name} exited`, { code, signal });
      this.logStream?.end();
    });
    log('info', `${this.options.name} started`, { pid: child.pid });
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child || !this.running || child.pid === undefined) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await killTree(child.pid);
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }
}

/** Kills a process and everything it started. */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolve(),
      );
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }
  });
}
