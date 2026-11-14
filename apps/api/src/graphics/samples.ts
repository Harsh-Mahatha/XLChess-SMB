import type { RenderDataInput } from '@smb/shared';

/**
 * Sample data for every template, for tests and `npm run graphics:render -- --sample`. The names, ratings and
 * results are placeholders for checking layout; real renders take verified facts from a research package.
 */
export const SAMPLE_DATA: Record<string, Omit<RenderDataInput, 'photos'>> = {
  'player-vs-player': {
    texts: {
      player_a: 'Gukesh',
      player_b: 'Sindarov',
      subtitle: 'World Championship',
      a_rating: 'Classical 2700',
      b_rating: 'Classical 2650',
      result: '1-0',
      initials_a: 'DG',
      initials_b: 'JS',
    },
    flags: { a_flag: 'in', b_flag: 'uz' },
  },
  'upcoming-tournament': {
    texts: {
      event_name: 'Candidates Tournament 2026',
      dates: '1 - 16 April',
      venue: 'Toronto, Canada',
      format: 'Eight players, double round robin',
    },
  },
  'tournament-result': {
    texts: {
      event_name: 'Grand Chess Tour Finals',
      winner: 'Magnus Carlsen',
      winner_score: '7.5 / 9',
      second: '2. Hikaru Nakamura  7.0',
      third: '3. Fabiano Caruana  6.5',
      headline: 'Unbeaten through nine rounds',
    },
  },
  'player-ranking': {
    texts: {
      title: 'Top 5 classical',
      r1_name: 'Magnus Carlsen',
      r1_rating: '2830',
      r2_name: 'Hikaru Nakamura',
      r2_rating: '2810',
      r3_name: 'Fabiano Caruana',
      r3_rating: '2795',
      r4_name: 'Gukesh Dommaraju',
      r4_rating: '2790',
      r5_name: 'Arjun Erigaisi',
      r5_rating: '2775',
      footnote: 'Source: FIDE rating list, placeholder values',
    },
    flags: { r1_flag: 'no', r2_flag: 'us', r3_flag: 'us', r4_flag: 'in', r5_flag: 'in' },
  },
  'rating-movement': {
    texts: {
      player_name: 'Gukesh Dommaraju',
      rating_now: '2790',
      change: '+34',
      rating_before: 'From 2756',
      period: 'Since the October list',
    },
  },
  'chess-puzzle': {
    texts: {
      puzzle_title: 'Mate in two',
      prompt: 'White to move',
      hint: 'The queen sacrifice is not the first move.',
      source_line: 'Position from a rapid game, placeholder',
    },
    boards: { position: 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 9' },
  },
  'chess-news': {
    texts: {
      headline: 'FIDE confirms the dates for the next Candidates Tournament',
      summary: 'The event will be played over two weeks, with the winner earning a World Championship match.',
      source_line: 'Source: FIDE announcement',
    },
  },
  'xlchess-update': {
    texts: {
      headline: 'Puzzle streaks are here',
      body: 'Solve a puzzle every day to build a streak, and see how long you can keep it going.',
      cta: 'Update the app to try it',
      version_tag: 'Version 2.4',
    },
  },
};
