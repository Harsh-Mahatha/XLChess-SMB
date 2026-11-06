import { parseArgs } from 'node:util';
import { getDb } from '../db/client.js';
import { selectStory } from './service.js';

/**
 * Developer tool: run story selection for an opportunity that already has a research package.
 *   npm run story:select -w @smb/api -- --opportunity <id>
 * Needs DATABASE_URL. Prints every angle with its score and the reasons it was rejected.
 */
const { values } = parseArgs({ options: { opportunity: { type: 'string' } } });

if (!values.opportunity) {
  process.stderr.write('usage: story:select --opportunity <id>\n');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}

const db = await getDb();
const sel = await selectStory(db, values.opportunity);
process.stdout.write(
  `${sel.created ? 'stored' : 'already stored'} selection ${sel.id}: ${sel.outcome}` +
    `${sel.angleId ? ` -> ${sel.angleId} (${sel.score})` : ''}\n${sel.reason}\n\n`,
);
for (const r of sel.ranking) {
  const head = `${r.eligible ? '+' : '-'} ${r.angleId.padEnd(20)} ${r.score === undefined ? '    ' : r.score.toFixed(3)}`;
  const why = r.rejections.map((j) => `${j.code}: ${j.message}`).join('; ');
  process.stdout.write(`${head}  ${why}\n`);
}
await db.$disconnect();
