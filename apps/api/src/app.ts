import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Env } from './env.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { healthRouter } from './http/routes/health.js';

export const API_VERSION = '0.1.0';

export interface AppDeps {
  env: Env;
  logger: Logger;
}

/**
 * App factory (no listen) so tests can mount it with Supertest.
 * Route groups per docs/ARCHITECTURE.md section 7 are mounted here as modules land:
 *   /v1/*        XLChess JWT   (review, admin)
 *   /worker/v1/* device token  (home-PC worker)
 */
export function createApp({ env, logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter(env, API_VERSION));
  app.get('/v1/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument(API_VERSION));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
