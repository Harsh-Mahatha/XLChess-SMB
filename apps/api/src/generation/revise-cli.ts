import { parseArgs } from 'node:util';
import { OllamaProvider, StubProvider, type AiProvider } from '@smb/shared';
import { loadConfigSet } from '../config/index.js';
import { getDb } from '../db/client.js';
import { requestRevision } from '../review/actions.js';
import { reviseCandidate } from './revise.js';

/**
 * Developer tool: have the model rewrite one candidate from feedback (module 1.12).
 *   npm run candidates:revise -- --action <id>                      run a request made in the review screen
 *   npm run candidates:revise -- --candidate <id> --feedback "..."  make the request here, then run it
 *        [--tags too_long,tone] [--user cli] [--provider stub|ollama] [--model qwen3:8b] [--ollama-url <url>]
 * Needs DATABASE_URL. The default provider is the deterministic stub, which needs no model.
 */
const { values } = parseArgs({
  options: {
    action: { type: 'string' },
    candidate: { type: 'string' },
    feedback: { type: 'string' },
    tags: { type: 'string' },
    user: { type: 'string', default: 'cli' },
    provider: { type: 'string', default: 'stub' },
    model: { type: 'string', default: 'qwen3:8b' },
    'ollama-url': { type: 'string' },
  },
});

if (!values.action && !values.candidate) {
  process.stderr.write(
    'usage: candidates:revise (--action <id> | --candidate <id> --feedback "..." [--tags a,b] [--user cli]) [--provider stub|ollama] [--model qwen3:8b] [--ollama-url <url>]\n',
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
let actionId = values.action;
if (!actionId) {
  const newest = await db.post_revisions.findFirst({
    where: { candidate_id: values.candidate! },
    orderBy: { revision_no: 'desc' },
  });
  if (!newest) {
    process.stderr.write(`candidate ${values.candidate} has no revision\n`);
    process.exit(1);
  }
  const asked = await requestRevision({ db }, { userId: values.user! }, values.candidate!, {
    baseRevisionId: newest.id,
    feedback: values.feedback,
    feedbackTags: values.tags?.split(','),
  });
  actionId = asked.actionId;
  process.stdout.write(`request ${actionId} recorded (job ${asked.jobId})\n`);
}

const out = await reviseCandidate({ db, provider, channels: loadConfigSet().channels }, actionId);
const rev = await db.post_revisions.findUniqueOrThrow({ where: { id: out.revisionId } });
process.stdout.write(
  `${out.created ? 'stored' : 'already stored'} revision ${out.revisionNo} (${provider.name}/${provider.model}) - ${out.passed ? 'passed' : 'FAILED validation'}\n` +
    `  changed: ${out.changedFields.join(', ')}\n  ${rev.headline}\n  ${rev.caption}\n`,
);
const v = rev.validation as { issues?: { code: string; message: string }[] } | null;
for (const i of v?.issues ?? []) process.stdout.write(`  ! ${i.code}: ${i.message}\n`);
await db.$disconnect();
