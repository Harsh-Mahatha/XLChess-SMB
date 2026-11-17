import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorBody, HealthResponse } from '@smb/shared';
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

/** Route modules register their paths on `registry`; XLChess generates its typed client from this document. */
export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'XLChess SMB API', version },
    servers: [{ url: '/' }],
  });
}
