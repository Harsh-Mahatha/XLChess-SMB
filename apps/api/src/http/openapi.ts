import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorBody, HealthResponse } from '@smb/shared';

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

/** Route modules register their paths on `registry`; XLChess generates its typed client from this document. */
export function buildOpenApiDocument(version: string) {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'XLChess SMB API', version },
    servers: [{ url: '/' }],
  });
}
