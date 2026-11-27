import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ClaimRequest,
  ClaimedJob,
  CompleteRequest,
  CompleteResponse,
  ErrorBody,
  FailRequest,
  HealthResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  WorkerConfigResponse,
  WorkerDesiredState,
  WorkerPairRequest,
  WorkerPairResponse,
  WorkerStatusRequest,
} from '@smb/shared';
import {
  ActionBody,
  ApproveBody,
  CorrectionsQuery,
  EditBody,
  FeedbackSummaryQuery,
  IdParam,
  QueueQuery,
  ReviseBody,
} from '../review/schemas.js';
import {
  ListPublicationsQuery,
  PublicationIdParam,
  ResolvePublicationBody,
  RetryPublicationBody,
} from '../publishing/schemas.js';
import {
  AddTiebreakBody,
  BindGameBody,
  ChampionshipIdParam,
  ConcludeCycleBody,
  ConfirmGameBody,
  ConfirmGameParams,
  EditCycleBody,
  ForcePhaseBody,
  ListChampionshipsQuery,
  RegisterCycleBody,
  ResolveFlagBody,
  ResolveFlagParams,
} from '../championship/types.js';
import {
  DetectorIdParam,
  EventIdParam,
  ListEventsQuery,
  PatchDetectorBody,
} from './routes/events.js';
import {
  CreatePairingCodeBody,
  ListAuditQuery,
  ListConfigVersionsQuery,
  PostTypeIdParam,
  PutOverridesBody,
  RevokeWorkerBody,
  SetPublishModeBody,
  WorkerIdParam,
} from './routes/admin.js';
import { MetricsIdParam, MetricsQuery } from './routes/metrics.js';
import { CostRateBody } from '../metrics/cost.js';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Liveness and publish-mode check',
  responses: {
    200: {
      description: 'Service is up',
      content: { 'application/json': { schema: HealthResponse } },
    },
    500: { description: 'Error', content: { 'application/json': { schema: ErrorBody } } },
  },
});

// Reviewer API (module 1.11). Every route needs `Authorization: Bearer <XLChess token>` with a reviewer or admin role.
registry.registerComponent('securitySchemes', 'xlchessToken', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'A short-lived token minted by the XLChess backend for each call; its smb_role claim is reviewer or admin.',
});
const errors = {
  400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorBody } } },
  401: {
    description: 'Missing or invalid token',
    content: { 'application/json': { schema: ErrorBody } },
  },
  403: { description: 'Role not allowed', content: { 'application/json': { schema: ErrorBody } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  409: {
    description:
      'Not possible in the current state (stale hash, superseded revision, wrong status, asset not cleared)',
    content: { 'application/json': { schema: ErrorBody } },
  },
  422: {
    description: 'Refused by a rule (channel limits, reason required, schedule)',
    content: { 'application/json': { schema: ErrorBody } },
  },
};
const secured = [{ xlchessToken: [] }];
const ok = (description: string) => ({
  description,
  content: { 'application/json': { schema: z.object({}).passthrough() } },
});
const idempotency = z.object({ 'Idempotency-Key': z.string().min(8).max(100).optional() });

registry.registerPath({
  method: 'get',
  path: '/v1/review/queue',
  summary: 'Opportunities waiting for review',
  security: secured,
  request: { query: QueueQuery },
  responses: { 200: ok('Queue items'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/opportunities/{id}',
  summary:
    'Everything a reviewer needs: three candidates, claims and sources, graphics with photo credits, channel previews, history',
  security: secured,
  request: { params: IdParam },
  responses: { 200: ok('Opportunity detail'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/candidates/{id}/revisions',
  summary: 'Save an edit as a new revision',
  security: secured,
  request: { params: IdParam, body: { content: { 'application/json': { schema: EditBody } } } },
  responses: { 201: ok('The new revision'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/revisions/{id}/approve',
  summary: 'Approve the exact revision that was reviewed',
  security: secured,
  request: {
    params: IdParam,
    headers: idempotency,
    body: { content: { 'application/json': { schema: ApproveBody } } },
  },
  responses: { 200: ok('Replay of an earlier approval'), 201: ok('Approval recorded'), ...errors },
});
for (const [path, summary] of [
  ['reject', 'Reject the opportunity'],
  ['defer', 'Hold the opportunity for later'],
  [
    'regenerate',
    'Ask for three new candidates using the feedback; the tag wrong_angle also picks a different story',
  ],
  ['request-research', 'Send back for more fact checking'],
  ['reopen', 'Return a deferred opportunity to the queue'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `/v1/opportunities/{id}/${path}`,
    summary,
    security: secured,
    request: {
      params: IdParam,
      headers: idempotency,
      body: { content: { 'application/json': { schema: ActionBody } } },
    },
    responses: { 200: ok('Replay of an earlier action'), 201: ok('Action recorded'), ...errors },
  });
}

// Revisions and feedback learning (module 1.12).
registry.registerPath({
  method: 'post',
  path: '/v1/candidates/{id}/revise',
  summary:
    'Ask the model to rewrite one candidate from the feedback; the rewrite arrives as a new revision',
  security: secured,
  request: {
    params: IdParam,
    headers: idempotency,
    body: { content: { 'application/json': { schema: ReviseBody } } },
  },
  responses: { 200: ok('Replay of an earlier request'), 202: ok('Rewrite queued'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/feedback/tags',
  summary:
    'The feedback tag vocabulary: each tag with its category and whether it is a factual correction',
  security: secured,
  responses: { 200: ok('Categories and tags'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/feedback/summary',
  summary:
    'Per post type: reviewed, approved, approved without edits, rejected, regenerations, factual and creative edits, recurring tags and rejected angles. Rejected posts stay in the denominator',
  security: secured,
  request: { query: FeedbackSummaryQuery },
  responses: { 200: ok('Totals and one entry per post type'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/feedback/corrections',
  summary: 'What reviewers changed (text before and after) and what they said, newest first',
  security: secured,
  request: { query: CorrectionsQuery },
  responses: { 200: ok('Edits and feedback'), ...errors },
});

// Publications administration (module 1.13).
registry.registerPath({
  method: 'get',
  path: '/v1/publications',
  summary: 'List publications with status, channel, and cursor filtering',
  security: secured,
  request: { query: ListPublicationsQuery },
  responses: { 200: ok('List of publications'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/publications/{id}',
  summary: 'Publication detail and attempt history',
  security: secured,
  request: { params: PublicationIdParam },
  responses: { 200: ok('Publication detail with attempts'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/publications/{id}/retry',
  summary: 'Reset a failed publication to pending for retry on the next sweep',
  security: secured,
  request: {
    params: PublicationIdParam,
    headers: idempotency,
    body: { content: { 'application/json': { schema: RetryPublicationBody } } },
  },
  responses: { 200: ok('Publication reset to pending'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/publications/{id}/reconcile',
  summary: 'Trigger an immediate reconciliation lookup for an uncertain publication',
  security: secured,
  request: { params: PublicationIdParam },
  responses: { 200: ok('Reconciliation outcome'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/publications/{id}/resolve',
  summary: 'Record an administrator resolution decision for an uncertain publication',
  security: secured,
  request: {
    params: PublicationIdParam,
    headers: idempotency,
    body: { content: { 'application/json': { schema: ResolvePublicationBody } } },
  },
  responses: { 200: ok('Resolution recorded'), ...errors },
});

// Scheduling & Triggers (module 1.14). Admin-only routes.
const ListSchedulesQuery = z.object({
  postTypeId: z.string().optional(),
});
const SuspendScheduleBody = z.object({
  postTypeId: z.string().min(1),
  until: z.string().datetime().optional(),
  reason: z.string().min(3).max(300),
});
const ResumeScheduleBody = z.object({
  postTypeId: z.string().min(1),
});
const ListSchedulerLogQuery = z.object({
  postTypeId: z.string().optional(),
  outcome: z
    .enum([
      'created',
      'duplicate',
      'refused',
      'missed_coalesced',
      'missed_expired',
      'rule_inactive',
      'rule_active',
      'error',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});
const CreateManualOpportunityBody = z.object({
  postTypeId: z.string().min(1),
  reason: z.string().min(3).max(300),
  phase: z.string().min(1).optional(),
  eventRefs: z.record(z.string(), z.string()).optional(),
  gameRef: z.object({ sourceId: z.string(), externalId: z.string() }).optional(),
  scheduledFor: z.string().datetime().optional(),
});

registry.registerPath({
  method: 'get',
  path: '/v1/schedules',
  summary: 'List recurring schedules and active holds',
  security: secured,
  request: { query: ListSchedulesQuery },
  responses: { 200: ok('List of schedules and holds'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/schedules/suspend',
  summary: 'Temporarily or indefinitely suspend recurring schedules for a post type',
  security: secured,
  request: { body: { content: { 'application/json': { schema: SuspendScheduleBody } } } },
  responses: { 200: ok('Schedule suspended'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/schedules/resume',
  summary: 'Resume recurring schedules for a post type',
  security: secured,
  request: { body: { content: { 'application/json': { schema: ResumeScheduleBody } } } },
  responses: { 200: ok('Schedule resumed'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/scheduler/log',
  summary: 'Query immutable scheduler trigger log entries',
  security: secured,
  request: { query: ListSchedulerLogQuery },
  responses: { 200: ok('Trigger log entries'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/opportunities/manual',
  summary: 'Create a manual posting opportunity',
  security: secured,
  request: {
    headers: idempotency,
    body: { content: { 'application/json': { schema: CreateManualOpportunityBody } } },
  },
  responses: {
    200: ok('Duplicate opportunity returned'),
    201: ok('Opportunity created'),
    ...errors,
  },
});

// World Championship Lifecycle (module 1.15). Admin-only routes.
registry.registerPath({
  method: 'post',
  path: '/v1/championships',
  summary: 'Register a new World Championship cycle',
  security: secured,
  request: { body: { content: { 'application/json': { schema: RegisterCycleBody } } } },
  responses: { 201: ok('Championship registered'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/championships',
  summary: 'List championship cycles, newest first',
  security: secured,
  request: { query: ListChampionshipsQuery },
  responses: { 200: ok('Championship cycles'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/championships/{id}',
  summary: 'Get championship detail, games, confirmed score, open flags, log, and nextAction hints',
  security: secured,
  request: { params: ChampionshipIdParam },
  responses: { 200: ok('Championship detail'), ...errors },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/championships/{id}',
  summary: 'Edit editable championship fields or next-cycle info',
  security: secured,
  request: {
    params: ChampionshipIdParam,
    body: { content: { 'application/json': { schema: EditCycleBody } } },
  },
  responses: { 200: ok('Championship updated'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/games',
  summary: 'Add a tiebreak game row during tournament phase',
  security: secured,
  request: {
    params: ChampionshipIdParam,
    body: { content: { 'application/json': { schema: AddTiebreakBody } } },
  },
  responses: { 201: ok('Tiebreak game added'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/games/{kind}/{number}/confirm',
  summary: 'Confirm or correct an official game result (requires attested: true)',
  security: secured,
  request: {
    params: ConfirmGameParams,
    body: { content: { 'application/json': { schema: ConfirmGameBody } } },
  },
  responses: { 200: ok('Game confirmed or corrected'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/conclude',
  summary: 'Conclude a championship cycle after an early clinch or tiebreak decision',
  security: secured,
  request: {
    params: ChampionshipIdParam,
    body: { content: { 'application/json': { schema: ConcludeCycleBody } } },
  },
  responses: { 200: ok('Championship concluded'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/phase',
  summary: 'Force a championship phase transition (and optionally lock phase detection)',
  security: secured,
  request: {
    params: ChampionshipIdParam,
    body: { content: { 'application/json': { schema: ForcePhaseBody } } },
  },
  responses: { 200: ok('Phase forced'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/unlock',
  summary: 'Remove the phase lock from a championship cycle',
  security: secured,
  request: { params: ChampionshipIdParam },
  responses: { 200: ok('Phase unlocked'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/flags/{flagId}/resolve',
  summary: 'Resolve a manual-resolution championship flag',
  security: secured,
  request: {
    params: ResolveFlagParams,
    body: { content: { 'application/json': { schema: ResolveFlagBody } } },
  },
  responses: { 200: ok('Flag resolved'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/championships/{id}/sync',
  summary: 'Force an immediate feed sync for the current championship cycle',
  security: secured,
  request: { params: ChampionshipIdParam },
  responses: { 200: ok('Sync completed'), ...errors },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/championships/{id}/games/{kind}/{number}',
  summary: 'Bind a championship game to its D3 round or game (needed for tiebreaks)',
  security: secured,
  request: {
    params: ConfirmGameParams,
    body: { content: { 'application/json': { schema: BindGameBody } } },
  },
  responses: { 200: ok('Game bound'), ...errors },
});

// Event detection and trigger ingestion (module 1.16). Admin-only routes.
registry.registerPath({
  method: 'get',
  path: '/v1/events',
  summary: 'List detected events (the event ledger), newest first',
  security: secured,
  request: { query: ListEventsQuery },
  responses: { 200: ok('Detected events'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/events/{id}',
  summary:
    'Get a detected event with its payload, versions and opportunity (stale when built from an older version)',
  security: secured,
  request: { params: EventIdParam },
  responses: { 200: ok('Detected event'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/event-pollers',
  summary: 'List event detectors with health, backoff and next due time',
  security: secured,
  responses: { 200: ok('Event detectors'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/event-pollers/{id}/run',
  summary: 'Run one event detector now',
  security: secured,
  request: { params: DetectorIdParam },
  responses: { 200: ok('Detector run'), ...errors },
});
registry.registerPath({
  method: 'patch',
  path: '/v1/event-pollers/{id}',
  summary: 'Pause or resume one event detector',
  security: secured,
  request: {
    params: DetectorIdParam,
    body: { content: { 'application/json': { schema: PatchDetectorBody } } },
  },
  responses: { 200: ok('Detector updated'), ...errors },
});

// Worker device protocol (module 1.18).
registry.registerComponent('securitySchemes', 'workerToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Opaque revocable device token (smbw_...) issued by POST /worker/v1/pair.',
});
const workerSecured = [{ workerToken: [] }];

registry.registerPath({
  method: 'post',
  path: '/worker/v1/pair',
  tags: ['worker'],
  summary: 'Exchange a single-use pairing code for a device token',
  request: { body: { content: { 'application/json': { schema: WorkerPairRequest } } } },
  responses: {
    201: {
      description: 'Worker paired',
      content: { 'application/json': { schema: WorkerPairResponse } },
    },
    ...errors,
  },
});
registry.registerPath({
  method: 'post',
  path: '/worker/v1/status',
  tags: ['worker'],
  summary: 'Report worker health and GPU status and receive desired state',
  security: workerSecured,
  request: { body: { content: { 'application/json': { schema: WorkerStatusRequest } } } },
  responses: {
    200: {
      description: 'Desired worker state',
      content: { 'application/json': { schema: WorkerDesiredState } },
    },
    ...errors,
  },
});
registry.registerPath({
  method: 'get',
  path: '/worker/v1/config',
  tags: ['worker'],
  summary: 'Read worker configuration, prompt versions and model settings',
  security: workerSecured,
  responses: {
    200: {
      description: 'Worker config',
      content: { 'application/json': { schema: WorkerConfigResponse } },
    },
    ...errors,
  },
});
registry.registerPath({
  method: 'post',
  path: '/worker/v1/jobs/claim',
  tags: ['worker'],
  summary: 'Claim the next eligible GPU job',
  security: workerSecured,
  request: { body: { content: { 'application/json': { schema: ClaimRequest } } } },
  responses: {
    200: {
      description: 'Claimed job',
      content: { 'application/json': { schema: ClaimedJob } },
    },
    204: { description: 'No job available or worker paused' },
    ...errors,
  },
});
registry.registerPath({
  method: 'post',
  path: '/worker/v1/jobs/{id}/heartbeat',
  tags: ['worker'],
  summary: 'Extend the lease on a claimed GPU job',
  security: workerSecured,
  request: {
    params: WorkerIdParam,
    body: { content: { 'application/json': { schema: HeartbeatRequest } } },
  },
  responses: {
    200: {
      description: 'Heartbeat result',
      content: { 'application/json': { schema: HeartbeatResponse } },
    },
    ...errors,
  },
});
registry.registerPath({
  method: 'post',
  path: '/worker/v1/jobs/{id}/complete',
  tags: ['worker'],
  summary: 'Submit the result of a claimed GPU job',
  security: workerSecured,
  request: {
    params: WorkerIdParam,
    body: { content: { 'application/json': { schema: CompleteRequest } } },
  },
  responses: {
    200: {
      description: 'Completion outcome',
      content: { 'application/json': { schema: CompleteResponse } },
    },
    ...errors,
  },
});
registry.registerPath({
  method: 'post',
  path: '/worker/v1/jobs/{id}/fail',
  tags: ['worker'],
  summary: 'Report a failure on a claimed GPU job',
  security: workerSecured,
  request: {
    params: WorkerIdParam,
    body: { content: { 'application/json': { schema: FailRequest } } },
  },
  responses: { 200: ok('Failure recorded'), ...errors },
});

// Administration routes (module 1.18). Admin-only.
registry.registerPath({
  method: 'post',
  path: '/v1/admin/workers/pairing-codes',
  tags: ['admin'],
  summary: 'Create a single-use 10-minute pairing code for a home-PC worker',
  security: secured,
  request: { body: { content: { 'application/json': { schema: CreatePairingCodeBody } } } },
  responses: { 201: ok('Pairing code created'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/workers',
  tags: ['admin'],
  summary: 'List paired workers with online status, active jobs and latest self-test',
  security: secured,
  responses: { 200: ok('Paired workers'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/admin/workers/{id}/pause',
  tags: ['admin'],
  summary: 'Pause new job claims for a worker',
  security: secured,
  request: { params: WorkerIdParam },
  responses: { 200: ok('Worker paused'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/admin/workers/{id}/resume',
  tags: ['admin'],
  summary: 'Resume job claims for a worker',
  security: secured,
  request: { params: WorkerIdParam },
  responses: { 200: ok('Worker resumed'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/admin/workers/{id}/revoke',
  tags: ['admin'],
  summary: 'Revoke a worker token and return its leased jobs to the queue',
  security: secured,
  request: {
    params: WorkerIdParam,
    body: { content: { 'application/json': { schema: RevokeWorkerBody } } },
  },
  responses: { 200: ok('Worker revoked'), ...errors },
});
registry.registerPath({
  method: 'post',
  path: '/v1/admin/workers/{id}/selftest',
  tags: ['admin'],
  summary: 'Queue a worker_selftest job for a worker',
  security: secured,
  request: { params: WorkerIdParam },
  responses: { 202: ok('Self-test queued'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/publish-mode',
  tags: ['admin'],
  summary: 'Get stored publish mode setting, environment ceiling, effective mode and live gates',
  security: secured,
  responses: { 200: ok('Publish mode state'), ...errors },
});
registry.registerPath({
  method: 'put',
  path: '/v1/admin/publish-mode',
  tags: ['admin'],
  summary: 'Change the publish mode setting (live requires confirmation and all environment gates)',
  security: secured,
  request: { body: { content: { 'application/json': { schema: SetPublishModeBody } } } },
  responses: { 200: ok('Publish mode updated'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/post-types/{id}/config',
  tags: ['admin'],
  summary: 'Get the active effective configuration for a post type',
  security: secured,
  request: { params: PostTypeIdParam },
  responses: { 200: ok('Active post-type config'), ...errors },
});
registry.registerPath({
  method: 'put',
  path: '/v1/admin/post-types/{id}/overrides',
  tags: ['admin'],
  summary: 'Apply a runtime override patch to a post type',
  security: secured,
  request: {
    params: PostTypeIdParam,
    body: { content: { 'application/json': { schema: PutOverridesBody } } },
  },
  responses: { 200: ok('Override saved'), ...errors },
});
registry.registerPath({
  method: 'delete',
  path: '/v1/admin/post-types/{id}/overrides',
  tags: ['admin'],
  summary: 'Clear runtime overrides for a post type',
  security: secured,
  request: { params: PostTypeIdParam },
  responses: { 200: ok('Override cleared'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/configs/versions',
  tags: ['admin'],
  summary: 'List post-type config versions, newest first',
  security: secured,
  request: { query: ListConfigVersionsQuery },
  responses: { 200: ok('Config versions'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/audit',
  tags: ['admin'],
  summary: 'Query the append-only audit log, newest first',
  security: secured,
  request: { query: ListAuditQuery },
  responses: { 200: ok('Audit log entries'), ...errors },
});

// Monitoring, cost and quality KPIs (module 1.19). Admin-only.
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/dashboard',
  tags: ['admin'],
  summary:
    'Everything the KPI dashboard shows for the last N days: the ten-day streak, quality, operations, cost per approved post and health alerts',
  security: secured,
  request: { query: MetricsQuery },
  responses: { 200: ok('Dashboard figures'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/streak',
  tags: ['admin'],
  summary:
    'Day-by-day unedited-approval record and the current and best streak. Rejected posts count towards each day; days under the required volume are not evaluated',
  security: secured,
  request: { query: MetricsQuery },
  responses: { 200: ok('Streak report'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/operations',
  tags: ['admin'],
  summary:
    'Opportunities, jobs, failures, queues, publication success and duplicate prevention for the last N days',
  security: secured,
  request: { query: MetricsQuery },
  responses: { 200: ok('Operational figures'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/cost',
  tags: ['admin'],
  summary: 'Compute, review time, hosting and the cost per approved post for the last N days',
  security: secured,
  request: { query: MetricsQuery },
  responses: { 200: ok('Cost figures'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/health',
  tags: ['admin'],
  summary: 'Active problems, workers with their current job, and event pollers',
  security: secured,
  responses: { 200: ok('Health report'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/metrics/opportunities/{id}/cost',
  tags: ['admin'],
  summary: 'What one post cost to write and review: GPU time, tokens, compute and review time',
  security: secured,
  request: { params: MetricsIdParam },
  responses: { 200: ok('Cost of one post'), ...errors },
});
registry.registerPath({
  method: 'get',
  path: '/v1/admin/cost-rates',
  tags: ['admin'],
  summary: 'The price lists behind the cost figures, oldest first',
  security: secured,
  responses: { 200: ok('Price lists'), ...errors },
});
registry.registerPath({
  method: 'put',
  path: '/v1/admin/cost-rates',
  tags: ['admin'],
  summary: 'Add a price list from today (or a later day). Unset prices carry over. Audited',
  security: secured,
  request: { body: { content: { 'application/json': { schema: CostRateBody } } } },
  responses: { 201: ok('Price list added'), ...errors },
});

/** Route modules register their paths on `registry`; XLChess generates its typed client from this document. */
export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'XLChess SMB API', version },
    servers: [{ url: '/' }],
  });
}
