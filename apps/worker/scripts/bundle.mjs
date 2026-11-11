// Bundles the worker (and @smb/shared, zod) into one file for the installer package: no node_modules on the PC.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'bundle');

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(outDir, 'worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  define: { __WORKER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});

mkdirSync(join(outDir, 'workflows'), { recursive: true });
copyFileSync(
  join(root, 'workflows', 'z-image-turbo.json'),
  join(outDir, 'workflows', 'z-image-turbo.json'),
);
