import { parseArgs } from 'node:util';
import { OllamaProvider, StubProvider, type AiProvider } from '@smb/shared';
import { loadConfigSet } from '../config/index.js';
import { getDb } from '../db/client.js';
import { generateCandidates } from './service.js';

/**
 * Developer tool: write the three candidate posts for an opportunity whose story is selected.
 *   npm run candidates:generate -w @smb/api -- --opportunity <id> [--provider stub|ollama]
 *        [--model qwen3:8b] [--ollama-url http://127.0.0.1:11434] [--new-cycle]
 * Needs DATABASE_URL. The default provider is the deterministic stub, which needs no model.
 */
const { values } = parseArgs({
  options: {
    opportunity: { type: 'string' },
    provider: { type: 'string', default: 'stub' },
    model: { type: 'string', default: 'qwen3:8b' },
    'ollama-url': { type: 'string' },
    'new-cycle': { type: 'boolean', default: false },
  },
});

if (!values.opportunity) {
  process.stderr.write(
    'usage: candidates:generate --opportunity <id> [--provider stub|ollama] [--model qwen3:8b] [--ollama-url <url>] [--new-cycle]\n',
  );
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

let provider: AiProvider;
if (values.provider === 'stub') {
  provider = new StubProvider();
} else if (values.provider === 'ollama') {
  provider = new OllamaProvider({
    model: values.model!,
    baseUrl: values['ollama-url'] ?? process.env.OLLAMA_URL,
  });
} else {
  process.stderr.write(`unknown provider "${values.provider}" (use stub or ollama)\n`);
  process.exit(2);
}

const db = await getDb();
const channels = loadConfigSet().channels;
const out = await generateCandidates({ db, provider, channels }, values.opportunity, {
  newCycle: values['new-cycle'],
});
process.stdout.write(
  `${out.created ? 'stored' : 'already stored'} cycle ${out.cycle} (${provider.name}/${provider.model})\n`,
);
const rows = await db.post_candidates.findMany({
  where: { id: { in: out.candidates.map((c) => c.id) } },
  orderBy: { slot: 'asc' },
  include: { post_revisions: true },
});
for (const r of rows) {
  const rev = r.post_revisions[0]!;
  const v = r.validation as {
    passed: boolean;
    text: { issues: { code: string; message: string }[] };
  };
  process.stdout.write(
    `\n[${r.slot}] ${r.approach} - ${v.passed ? 'passed' : 'FAILED validation'}\n  ${rev.headline}\n  ${rev.caption}\n`,
  );
  for (const i of v.text.issues) process.stdout.write(`  ! ${i.code}: ${i.message}\n`);
}
await db.$disconnect();
