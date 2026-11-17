import { describe, expect, it } from 'vitest';
import { DryRunPublisher } from '../../../apps/api/src/publishing/x/dry-run.js';
import { publisherFor } from '../../../apps/api/src/publishing/registry.js';
import { ApprovedPost } from '../../../apps/api/src/publishing/types.js';
import { XPublisher } from '../../../apps/api/src/publishing/x/adapter.js';
import { XClient } from '../../../apps/api/src/publishing/x/client.js';

describe('publishing registry & DryRunPublisher', () => {
  const samplePost: ApprovedPost = {
    publicationId: '00000000-0000-4000-8000-000000000001',
    opportunityId: '00000000-0000-4000-8000-000000000002',
    postTypeId: '1.1',
    approvalId: '00000000-0000-4000-8000-000000000003',
    revisionId: '00000000-0000-4000-8000-000000000004',
    contentHash: 'a'.repeat(64),
    channel: 'x',
    mode: 'dry_run',
    text: 'Dry run announcement',
    media: [
      {
        assetId: '00000000-0000-4000-8000-000000000005',
        bytes: new Uint8Array([10, 20]),
        mime: 'image/png',
        sha256: 'b'.repeat(64),
        altText: 'Dry run graphic',
      },
    ],
    idempotencyKey: 'pub:dry-run:1',
  };

  it('DryRunPublisher publishes without network and records exact request summary', async () => {
    const publisher = new DryRunPublisher();
    const result = await publisher.publish(samplePost);

    expect(result.kind).toBe('dry_run');
    if (result.kind === 'dry_run') {
      expect(result.request).toEqual({
        channel: 'x',
        text: 'Dry run announcement',
        length: 20,
        media: [
          {
            assetId: '00000000-0000-4000-8000-000000000005',
            sha256: 'b'.repeat(64),
            bytes: 2,
            mime: 'image/png',
            altText: 'Dry run graphic',
          },
        ],
      });
    }

    expect(await publisher.lookup()).toEqual({ kind: 'absent' });
    expect(await publisher.getStatus()).toBe('unknown');
  });

  it('publisherFor returns DryRunPublisher in dry_run mode', () => {
    const pub = publisherFor('dry_run', 'x', {});
    expect(pub).toBeInstanceOf(DryRunPublisher);
  });

  it('publisherFor returns XPublisher in sandbox/live when configured', () => {
    const client = new XClient({
      baseUrl: 'https://api.x.com',
      creds: { apiKey: 'k', apiSecret: 's', accessToken: 't', accessTokenSecret: 'ts' },
      timeoutMs: 5000,
    });
    const xPub = new XPublisher({ client, userId: '123' });

    const pub = publisherFor('sandbox', 'x', { x: xPub });
    expect(pub).toBe(xPub);

    const livePub = publisherFor('live', 'x', { x: xPub });
    expect(livePub).toBe(xPub);
  });

  it('publisherFor throws when channel is not configured in sandbox/live', () => {
    expect(() => publisherFor('sandbox', 'x', {})).toThrow(
      expect.objectContaining({ kind: 'permanent', code: 'not_configured' }),
    );
  });

  it('publisherFor throws when channel is not supported', () => {
    expect(() => publisherFor('dry_run', 'facebook', {})).toThrow(
      expect.objectContaining({ kind: 'permanent', code: 'channel_not_supported' }),
    );
  });
});
