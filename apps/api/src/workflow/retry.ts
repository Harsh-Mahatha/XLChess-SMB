import type { PrismaClient } from '@prisma/client';
import { PostTypeConfig } from '@smb/shared';
import { backoffSeconds, type JobRow } from '../jobs/index.js';

/** Computes the retry delay in seconds for a job from its opportunity's post-type retry policy. */
export async function backoffFor(
  db: PrismaClient,
  job: Pick<JobRow, 'opportunity_id'>,
  attempts: number,
): Promise<number> {
  if (job.opportunity_id) {
    const opp = await db.post_opportunities.findUnique({ where: { id: job.opportunity_id } });
    const row = opp && (await db.post_configs.findUnique({ where: { id: opp.post_config_id } }));
    if (row) {
      return backoffSeconds(attempts, PostTypeConfig.parse(row.config_json).retryPolicy);
    }
  }
  return backoffSeconds(attempts, { backoffSeconds: 60, backoffMultiplier: 2 });
}
