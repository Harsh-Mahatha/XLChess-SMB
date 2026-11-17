import type { Prisma, PrismaClient } from '@prisma/client';
import type { ReviewerFeedback } from '@smb/shared';

/** How many earlier regeneration requests are passed on with the newest one. */
const MAX_EARLIER = 5;

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * What a reviewer asked for when they sent an opportunity back for new candidates (module 1.12): the newest
 * regeneration request, the ones before it, and the posts they turned down as they last stood. It is read
 * from the database, not from the job payload, so a run from the command line and a run from the queue
 * give the model the same thing. Returns undefined when nobody has asked for a regeneration.
 */
export async function loadReviewerFeedback(
  db: PrismaClient | Prisma.TransactionClient,
  opportunityId: string,
): Promise<ReviewerFeedback | undefined> {
  const requests = await db.review_actions.findMany({
    where: { opportunity_id: opportunityId, action: 'regenerate' },
    orderBy: { created_at: 'asc' },
  });
  const latest = requests[requests.length - 1];
  if (!latest) return undefined;

  const newest = await db.post_candidates.aggregate({
    where: { opportunity_id: opportunityId },
    _max: { generation_cycle: true },
  });
  const turnedDown = newest._max.generation_cycle
    ? await db.post_candidates.findMany({
        where: { opportunity_id: opportunityId, generation_cycle: newest._max.generation_cycle },
        orderBy: { slot: 'asc' },
        include: { post_revisions: { orderBy: { revision_no: 'desc' }, take: 1 } },
      })
    : [];

  return {
    actionId: latest.id,
    text: latest.feedback,
    tags: latest.feedback_tags,
    earlier: requests
      .slice(0, -1)
      .slice(-MAX_EARLIER)
      .map((r) => ({ text: r.feedback, tags: r.feedback_tags })),
    previousPosts: turnedDown.flatMap((c) => {
      const rev = c.post_revisions[0];
      return rev
        ? [
            {
              slot: c.slot,
              headline: rev.headline ?? '',
              caption: rev.caption,
              target: c.id === latest.candidate_id,
            },
          ]
        : [];
    }),
  };
}

export { stringMap };
