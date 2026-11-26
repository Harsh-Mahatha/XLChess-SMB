import type { PrismaClient } from '@prisma/client';
import { StubProvider } from '@smb/shared';
import type { Logger } from 'pino';
import type { loadConfigSet } from '../config/loader.js';
import type { Env } from '../env.js';
import { loadTemplates } from '../graphics/registry.js';
import { HttpImageDownloader, createImageRuntimes } from '../images/index.js';
import {
  PrismaSourceRecordStore,
  USER_AGENT,
  createSourceGateway,
  type SourceGateway,
} from '../sources/index.js';
import type { ObjectStore } from '../storage/index.js';
import type { WorkflowDeps } from './types.js';

/**
 * The real dependencies of the workflow, built from the environment. With `SMB_AI_PROVIDER=stub` the gpu lane
 * runs inside the API with the deterministic stub; with `worker` gpu jobs wait for a paired PC (module 1.18).
 */
export function createWorkflowDeps(o: {
  db: PrismaClient;
  store: ObjectStore;
  configSet: ReturnType<typeof loadConfigSet>;
  env: Env;
  logger: Logger;
  /** Share the gateway the rest of the API uses, so provider rate limits hold across all callers. */
  gateway?: SourceGateway;
}): WorkflowDeps {
  const { db, store, configSet, env, logger } = o;
  const userAgent = env.SMB_CONTACT ? `${USER_AGENT} ${env.SMB_CONTACT}` : USER_AGENT;
  return {
    db,
    store,
    channels: configSet.channels,
    logger,
    gateway: o.gateway ?? createSourceGateway(configSet.sources, new PrismaSourceRecordStore(db)),
    sources: configSet.sources,
    templates: loadTemplates(),
    imageRuntimes: createImageRuntimes(configSet.sources, { userAgent }),
    downloader: new HttpImageDownloader({ userAgent }),
    allowShareAlike: env.IMAGE_ALLOW_SHARE_ALIKE,
    provider: env.SMB_AI_PROVIDER === 'stub' ? new StubProvider() : undefined,
  };
}
