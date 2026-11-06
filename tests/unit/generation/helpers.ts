import {
  buildGenerationInput,
  type CandidateDraft,
  type ChannelsRegistry,
  type ClaimView,
  type GenerationInput,
} from '../../../packages/shared/src/index.js';

export const CHANNELS: ChannelsRegistry = {
  schemaVersion: 1,
  channels: [
    {
      id: 'x',
      name: 'X',
      enabled: true,
      maxTextLength: 280,
      maxImages: 4,
      mediaRequired: false,
      altTextRequired: true,
    },
    {
      id: 'facebook',
      name: 'Facebook',
      enabled: false,
      maxTextLength: 63206,
      maxImages: 10,
      mediaRequired: false,
      altTextRequired: true,
    },
  ],
};

export const claim = (
  claimKey: string,
  value: unknown,
  verification: ClaimView['verification'] = 'verified',
  eventTime?: string,
): ClaimView => ({ claimKey, value, verification, confidence: 0.9, eventTime });

export const TOURNAMENT_CLAIMS: ClaimView[] = [
  claim('game.result', { result: '1-0', white: 'Gukesh D', black: 'Sindarov J', round: '3' }),
  claim('match.score', {
    players: [
      { name: 'Gukesh D', points: 2 },
      { name: 'Sindarov J', points: 1 },
    ],
    completedGames: 3,
  }),
  claim('match.situation', {
    leader: 'Gukesh D',
    tied: false,
    margin: 1,
    roundsRemaining: 11,
    totalRounds: 14,
  }),
  claim(
    'game.key_moments',
    [{ ply: 44, moveNumber: 22, san: 'Qxd5', evalBefore: 0.4, evalAfter: 3.1, swing: 2.7 }],
    'single_source',
  ),
  claim('next_game', { name: 'Round 4', startsAt: '2026-11-08T12:00:00Z' }, 'single_source'),
];

export function makeInput(
  over: { claims?: ClaimView[]; angle?: string; channelIds?: ('x' | 'facebook')[] } = {},
): GenerationInput {
  return buildGenerationInput({
    postType: '1.1',
    opportunityId: 'opp-1',
    packageId: 'pkg-1',
    phase: 'tournament',
    angleId: over.angle ?? 'game_result',
    claims: over.claims ?? TOURNAMENT_CLAIMS,
    contentRules: {
      tone: 'Authoritative, factual and engaging for chess fans.',
      structure: ['headline result', 'updated match score'],
      restrictions: ['Do not state predictions as facts.'],
    },
    channelIds: over.channelIds ?? ['x'],
    channels: CHANNELS,
    imageRules: {
      need: 'preferred',
      preferOriginalPhoto: true,
      template: 'game-result',
      composition: ['Use a licensed photograph of the players or venue where one is available.'],
    },
  });
}

/** A candidate that passes every check for `makeInput()`. */
export const GOOD_DRAFT: CandidateDraft = {
  headline: 'Gukesh D wins round 3',
  caption: 'Round 3: Gukesh D (White) vs Sindarov J (Black) ended 1-0.',
  channelTexts: { x: 'Round 3: Gukesh D (White) vs Sindarov J (Black) ended 1-0.' },
  claimKeys: ['game.result'],
  hashtags: ['#Chess'],
};
