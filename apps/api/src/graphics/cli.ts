/* eslint-disable no-console -- command-line tool */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ASPECTS, photoSlots, type Aspect, type RenderDataInput } from '@smb/shared';
import { getDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import {
  BUCKETS,
  InMemoryObjectStore,
  SupabaseObjectStore,
  type ObjectStore,
} from '../storage/index.js';
import { loadTemplates } from './registry.js';
import { renderGraphic } from './render.js';
import { SAMPLE_DATA } from './samples.js';
import { GraphicError } from './text.js';

/**
 * Developer tool for graphics (module 1.10).
 *   npm run graphics:render -- list
 *   npm run graphics:render -- render --template <id> [--aspect 16:9] [--sample | --data file.json]
 *       [--photo slot=assetId ...] [--candidate <id>] [--out file.png] [--store supabase|memory]
 * `render` needs DATABASE_URL (photographs are cut and checked through the database). `--store memory` keeps files in
 * memory only, so use it against a throwaway database; `--out` writes the finished PNG.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: 'string' },
    aspect: { type: 'string', default: '16:9' },
    sample: { type: 'boolean', default: false },
    data: { type: 'string' },
    photo: { type: 'string', multiple: true },
    candidate: { type: 'string' },
    out: { type: 'string' },
    store: { type: 'string', default: 'supabase' },
  },
});

const registry = loadTemplates();
const command = positionals[0] ?? 'list';

if (command === 'list') {
  for (const m of registry.manifests) {
    console.log(
      `${m.id}@${m.version}${m.aliases.length ? ` (also ${m.aliases.join(', ')})` : ''}: ${m.name}`,
    );
    for (const aspect of Object.keys(m.aspects) as Aspect[]) {
      const slots = photoSlots(m, aspect)
        .map((s) => `${s.id} ${s.width}x${s.height}${s.required ? ' required' : ''}`)
        .join(', ');
      console.log(
        `  ${aspect}  ${m.aspects[aspect]!.width}x${m.aspects[aspect]!.height}  photos: ${slots || 'none'}`,
      );
    }
  }
  process.exit(0);
}

if (command !== 'render' || !values.template) {
  console.error(
    'usage: graphics:render -- list | render --template <id> [--aspect 16:9] [--sample] [--photo slot=assetId]',
  );
  process.exit(2);
}
if (!(ASPECTS as readonly string[]).includes(values.aspect!)) {
  console.error(`unknown aspect "${values.aspect}" (use ${ASPECTS.join(', ')})`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

let data: RenderDataInput = {};
if (values.data) data = JSON.parse(readFileSync(values.data, 'utf8')) as RenderDataInput;
else if (values.sample) {
  const sample = SAMPLE_DATA[registry.get(values.template).id];
  if (!sample) {
    console.error(`no sample data for ${values.template}`);
    process.exit(2);
  }
  data = sample;
}
const photos: NonNullable<RenderDataInput['photos']> = { ...(data.photos ?? {}) };
for (const p of values.photo ?? []) {
  const [slot, assetId] = p.split('=');
  if (!slot || !assetId) {
    console.error(`--photo needs slot=assetId, got "${p}"`);
    process.exit(2);
  }
  photos[slot] = { assetId };
}

const env = loadEnv();
let store: ObjectStore;
if (values.store === 'memory') store = new InMemoryObjectStore();
else {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed for --store supabase');
    process.exit(2);
  }
  store = new SupabaseObjectStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

try {
  const db = await getDb();
  const result = await renderGraphic(
    { db, store, registry },
    {
      template: values.template,
      aspect: values.aspect as Aspect,
      data: { ...data, photos },
      candidateId: values.candidate,
    },
  );
  if (values.out) {
    const bytes = await store.get(BUCKETS.renders, result.path);
    if (!bytes) throw new Error('the render was stored but could not be read back');
    writeFileSync(values.out, bytes);
  }
  console.log(JSON.stringify(result, null, 2));
  await db.$disconnect();
} catch (err) {
  console.error(err instanceof GraphicError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
}
