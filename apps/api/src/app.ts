import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Env } from './env.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { feedbackRouter } from './http/routes/feedback.js';
import { healthRouter } from './http/routes/health.js';
import { reviewRouter, type ReviewRouteDeps } from './http/routes/review.js';
import { publicationsRouter } from './http/routes/publications.js';
import type { PublishDeps } from './publishing/service.js';
import type { PrismaClient } from '@prisma/client';
import type { TokenVerifier } from './auth/index.js';
import type { ContextResolvers } from './scheduling/index.js';

export const API_VERSION = '0.1.0';

export interface SchedulingRouteDeps {
  verifier?: TokenVerifier;
  db: PrismaClient;
  resolvers: ContextResolvers;
  logger: Logger;
}

export interface AppDeps {
  env: Env;
  logger: Logger;
  /** The reviewer API. Left out in tests and tools that only need the health route. */
  review?: ReviewRouteDeps;
  /** Publishing service deps. */
  publishing?: PublishDeps;
  /** Scheduling route deps. */
  scheduling?: SchedulingRouteDeps;
}

/**
 * App factory (no listen) so tests can mount it with Supertest.
 * Route groups per docs/ARCHITECTURE.md section 7 are mounted here as modules land:
 *   /v1/*        XLChess JWT   (review, admin)
 *   /worker/v1/* device token  (home-PC worker)
 */
export function createApp({ env, logger, review, publishing, scheduling: _scheduling }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter(env, API_VERSION));
  app.get('/v1/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument(API_VERSION));
  });
  if (review) {
    app.use(reviewRouter(review));
    app.use(feedbackRouter({ verifier: review.verifier, db: review.read.db }));
  }
  if (publishing) {
    app.use(publicationsRouter({ verifier: review?.verifier, publishing }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
