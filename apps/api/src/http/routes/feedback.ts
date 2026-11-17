import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { authenticate, requireRole, type TokenVerifier } from '../../auth/index.js';
import {
  CorrectionsQuery,
  FeedbackSummaryQuery,
  feedbackCorrections,
  feedbackSummary,
  feedbackVocabulary,
} from '../../review/index.js';

export interface FeedbackRouteDeps {
  verifier: TokenVerifier | undefined;
  db: PrismaClient;
}

/**
 * Feedback learning (module 1.12): the tag vocabulary, the acceptance and correction figures by post type, and
 * the corrections themselves. Read-only; reviewers and administrators.
 */
export function feedbackRouter({ verifier, db }: FeedbackRouteDeps): Router {
  const r = Router();
  r.use('/v1/feedback', authenticate(verifier), requireRole('reviewer', 'admin'));

  r.get('/v1/feedback/tags', (_req, res) => {
    res.json(feedbackVocabulary());
  });

  r.get('/v1/feedback/summary', async (req, res) => {
    const q = FeedbackSummaryQuery.parse(req.query);
    res.json(await feedbackSummary(db, q));
  });

  r.get('/v1/feedback/corrections', async (req, res) => {
    const q = CorrectionsQuery.parse(req.query);
    res.json(await feedbackCorrections(db, q));
  });
  return r;
}
