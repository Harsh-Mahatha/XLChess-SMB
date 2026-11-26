import type { PrismaClient } from '@prisma/client';
import type { AiProvider, ChannelsRegistry, SourcesRegistry } from '@smb/shared';
import type { Logger } from 'pino';
import type { ImageDownloader, ImageSourceRuntime } from '../images/index.js';
import type { TemplateRegistry } from '../graphics/registry.js';
import type { SourceGateway } from '../sources/index.js';
import type { ObjectStore } from '../storage/index.js';

/** Everything a step needs. Built once at start-up; tests pass fakes for the network and the model. */
export interface WorkflowDeps {
  db: PrismaClient;
  store: ObjectStore;
  channels: ChannelsRegistry;
  logger: Logger;
  gateway: SourceGateway;
  sources: SourcesRegistry;
  templates: TemplateRegistry;
  imageRuntimes: Map<string, ImageSourceRuntime>;
  downloader: ImageDownloader;
  allowShareAlike?: boolean;
  /**
   * Runs `gpu` jobs inside the API (the deterministic stub, or a local model). Without it gpu jobs wait in the
   * queue for a paired worker (module 1.18).
   */
  provider?: AiProvider;
  now?: () => Date;
  /** Lease lengths in seconds. A step that outlives its lease is re-queued, so these must exceed the slowest step. */
  leaseSeconds?: { server?: number; gpu?: number };
}

export const nowOf = (deps: Pick<WorkflowDeps, 'now'>): Date =>
  deps.now ? deps.now() : new Date();

/** The stage an opportunity returns to when a failed step is retried. */
export type WorkflowStep = 'researching' | 'generating';

/** The step each kind of job belongs to. Jobs that serve review or housekeeping have none. */
export const STEP_OF_KIND: Record<string, WorkflowStep | undefined> = {
  research_build: 'researching',
  story_select: 'researching',
  images_discover: 'generating',
  candidates_generate: 'generating',
  graphics_render: 'generating',
};
