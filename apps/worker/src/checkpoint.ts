import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const CheckpointSchema = z.object({
  jobId: z.string().uuid(),
  leaseId: z.string().uuid(),
  kind: z.string().min(1),
  startedAt: z.string().min(1),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

const CHECKPOINT_FILE = 'current.json';
const TEMP_FILE = 'current.json.tmp';

/** Writes the active job checkpoint atomically (temp file + rename). */
export function writeCheckpoint(checkpointsDir: string, cp: Checkpoint): void {
  mkdirSync(checkpointsDir, { recursive: true });
  const tmp = join(checkpointsDir, TEMP_FILE);
  const target = join(checkpointsDir, CHECKPOINT_FILE);
  writeFileSync(tmp, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

/** Reads the active job checkpoint, or returns null when none exists or it is unreadable. */
export function readCheckpoint(checkpointsDir: string): Checkpoint | null {
  const target = join(checkpointsDir, CHECKPOINT_FILE);
  if (!existsSync(target)) return null;
  try {
    const parsed = CheckpointSchema.safeParse(JSON.parse(readFileSync(target, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearCheckpoint(checkpointsDir: string): void {
  rmSync(join(checkpointsDir, CHECKPOINT_FILE), { force: true });
  rmSync(join(checkpointsDir, TEMP_FILE), { force: true });
}
