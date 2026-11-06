import type { PrismaClient } from '@prisma/client';
import {
  PostTypeConfig,
  buildGenerationInput,
  resolvePhase,
  type ChannelsRegistry,
  type ClaimView,
  type GenerationInput,
} from '@smb/shared';
import { StoryNotReadyError, assertReadyToGenerate } from '../story/service.js';

export class GenerationNotReadyError extends Error {
  constructor(
    public readonly opportunityId: string,
    reason: string,
  ) {
    super(`Cannot generate candidates for ${opportunityId}: ${reason}`);
    this.name = 'GenerationNotReadyError';
  }
}

export interface GenerationSubject {
  input: GenerationInput;
  selectionId: string;
  packageId: string;
}

/**
 * Everything the model may see for one opportunity, built from the database. It first passes the full
 * gate: the research package must be ready and a story must have been selected for it. This is also the
 * payload that will go to the home-PC worker as a job.
 */
export async function buildInputForOpportunity(
  db: PrismaClient,
  channels: ChannelsRegistry,
  opportunityId: string,
): Promise<GenerationSubject> {
  const opp = await db.post_opportunities.findUniqueOrThrow({ where: { id: opportunityId } });
  const selection = await db.story_selections.findFirst({
    where: { opportunity_id: opportunityId, outcome: 'selected' },
    orderBy: { created_at: 'desc' },
  });
  if (!selection) throw new StoryNotReadyError(opportunityId, 'no story has been selected');
  const packageId = selection.research_package_id;
  const angle = await assertReadyToGenerate(db, packageId);

  const row = await db.post_configs.findUniqueOrThrow({ where: { id: opp.post_config_id } });
  const config = PostTypeConfig.parse(row.config_json);
  const effective = resolvePhase(config, opp.phase);
  const claims = await db.research_claims.findMany({ where: { package_id: packageId } });
  const views: ClaimView[] = claims.map((c) => ({
    claimKey: c.claim_key,
    value: c.value,
    verification: c.verification,
    confidence: Number(c.confidence ?? 0),
    eventTime: c.event_time?.toISOString(),
  }));

  const input = buildGenerationInput({
    postType: opp.post_type_id,
    opportunityId,
    packageId,
    phase: opp.phase,
    angleId: angle.angleId,
    claims: views,
    contentRules: {
      tone: effective.contentRules.tone,
      structure: effective.contentRules.structure,
      restrictions: effective.contentRules.restrictions,
    },
    channelIds: config.channels,
    channels,
    imageRules: config.imageRules,
  });

  if (input.facts.length === 0) {
    throw new GenerationNotReadyError(opportunityId, 'no publishable facts for the selected story');
  }
  if (input.channels.length === 0) {
    throw new GenerationNotReadyError(opportunityId, 'no enabled channel to write for');
  }
  const missing = input.angle.requiredFacts.filter((k) => !input.facts.some((f) => f.key === k));
  if (missing.length > 0) {
    throw new GenerationNotReadyError(
      opportunityId,
      `the selected angle needs ${missing.join(', ')}, which is not publishable`,
    );
  }
  return { input, selectionId: selection.id, packageId };
}
