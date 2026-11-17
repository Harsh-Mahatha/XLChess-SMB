import { describe, expect, it } from 'vitest';
import { XClient } from '../../../apps/api/src/publishing/x/client.js';
import { XPublisher, validateXPost } from '../../../apps/api/src/publishing/x/adapter.js';
import { ApprovedPost, PublishError } from '../../../apps/api/src/publishing/types.js';

describe('XPublisher adapter unit tests', () => {
  const creds = {
    apiKey: 'my-api-key',
    apiSecret: 'my-api-secret',
    accessToken: 'my-access-token',
    accessTokenSecret: 'my-token-secret',
  };

  const samplePost: ApprovedPost = {
    publicationId: '00000000-0000-4000-8000-000000000001',
    opportunityId: '00000000-0000-4000-8000-000000000002',
    postTypeId: '1.1',
    approvalId: '00000000-0000-4000-8000-000000000003',
    revisionId: '00000000-0000-4000-8000-000000000004',
    contentHash: 'a'.repeat(64),
    channel: 'x',
    mode: 'sandbox',
    text: 'Magnus beats Hikaru in Game 7!',
    media: [
      {
        assetId: '00000000-0000-4000-8000-000000000005',
        bytes: new Uint8Array([1, 2, 3, 4]),
        mime: 'image/png',
        sha256: 'b'.repeat(64),
        altText: 'Magnus Carlsen celebrating his victory',
      },
    ],
    idempotencyKey: 'pub:00000000-0000-4000-8000-000000000003:x',
  };

  it('validates post: detects >280 chars, >4 images, missing alt text, and >5MB image', () => {
    expect(validateXPost(samplePost).ok).toBe(true);

    // > 280 chars
    const overLength = { ...samplePost, text: 'a'.repeat(281) };
    expect(validateXPost(overLength).ok).toBe(false);
    expect(validateXPost(overLength).problems[0]).toContain('exceeding X limit of 280');

    // > 4 media
    const fiveImages: ApprovedPost = {
      ...samplePost,
      media: Array.from({ length: 5 }, () => samplePost.media[0]!),
    };
    expect(validateXPost(fiveImages).ok).toBe(false);
    expect(validateXPost(fiveImages).problems[0]).toContain('too many media attachments');

    // Missing alt text
    const missingAlt: ApprovedPost = {
      ...samplePost,
      media: [{ ...samplePost.media[0]!, altText: '' }],
    };
    expect(validateXPost(missingAlt).ok).toBe(false);
    expect(validateXPost(missingAlt).problems[0]).toContain('missing required alt text');

    // > 5 MB
    const tooLarge: ApprovedPost = {
      ...samplePost,
      media: [{ ...samplePost.media[0]!, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }],
    };
    expect(validateXPost(tooLarge).ok).toBe(false);
    expect(validateXPost(tooLarge).problems[0]).toContain('exceeds 5 MB limit');
  });

  it('happy path: uploads media -> sets alt text -> creates tweet with media ID and returns URL', async () => {
    const recordedCalls: Array<{ url: string; method: string; body?: unknown }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const urlStr = input.toString();
      recordedCalls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body });

      if (urlStr.includes('/2/media/upload')) {
        return new Response(JSON.stringify({ data: { id: 'media-12345' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/2/media/metadata')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/2/tweets')) {
        return new Response(
          JSON.stringify({
            data: { id: 'tweet-99999', text: 'Magnus beats Hikaru in Game 7!' },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const client = new XClient({
      baseUrl: 'https://api.x.com',
      creds,
      timeoutMs: 5000,
      fetchImpl,
    });

    const publisher = new XPublisher({
      client,
      userId: '12345678',
      username: 'xlchess_bot',
      now: () => new Date('2026-11-17T12:00:00Z'),
    });

    const result = await publisher.publish(samplePost);

    expect(result.kind).toBe('published');
    if (result.kind === 'published') {
      expect(result.externalId).toBe('tweet-99999');
      expect(result.url).toBe('https://x.com/xlchess_bot/status/tweet-99999');
      expect(result.publishedAt.toISOString()).toBe('2026-11-17T12:00:00.000Z');
    }

    expect(recordedCalls).toHaveLength(3);
    expect(recordedCalls[0]!.url).toContain('/2/media/upload');
    expect(recordedCalls[1]!.url).toContain('/2/media/metadata');
    expect(recordedCalls[2]!.url).toContain('/2/tweets');
    // Ensure tweet body contains media id
    expect(recordedCalls[2]!.body).toContain('media-12345');

    // Never contain credentials in result or response
    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(creds.apiKey);
    expect(resultJson).not.toContain(creds.apiSecret);
    expect(resultJson).not.toContain(creds.accessToken);
    expect(resultJson).not.toContain(creds.accessTokenSecret);
    expect(resultJson).not.toContain('Authorization');
  });

  it('media upload 500 -> throws before_send and create post is never called', async () => {
    let createCalled = false;
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/2/media/upload')) {
        return new Response('Internal error', { status: 500 });
      }
      if (url.includes('/2/tweets')) {
        createCalled = true;
      }
      return new Response('ok', { status: 200 });
    };

    const client = new XClient({
      baseUrl: 'https://api.x.com',
      creds,
      timeoutMs: 5000,
      fetchImpl,
    });

    const publisher = new XPublisher({ client, userId: '12345' });

    await expect(publisher.publish(samplePost)).rejects.toSatisfy((err: unknown) => {
      const pErr = err as PublishError;
      return pErr.name === 'PublishError' && pErr.kind === 'before_send';
    });

    expect(createCalled).toBe(false);
  });

  it('create post times out -> throws uncertain', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/2/media/upload')) {
        return new Response(JSON.stringify({ data: { id: 'm1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/2/media/metadata')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/2/tweets')) {
        return new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      }
      return new Response('ok');
    };

    const client = new XClient({
      baseUrl: 'https://api.x.com',
      creds,
      timeoutMs: 50, // short timeout for test
      fetchImpl,
    });

    const publisher = new XPublisher({ client, userId: '12345' });

    await expect(publisher.publish(samplePost)).rejects.toSatisfy((err: unknown) => {
      const pErr = err as PublishError;
      return (
        pErr.name === 'PublishError' &&
        pErr.kind === 'uncertain' &&
        pErr.code === 'create_uncertain'
      );
    });
  });

  it('maps HTTP status codes: 503 -> uncertain, 403 duplicate -> uncertain/duplicate_content, 429 -> rate_limited, 401 -> permanent/x_auth, 400 -> permanent/x_refused', async () => {
    const postWithoutMedia: ApprovedPost = {
      ...samplePost,
      media: [],
    };

    const testStatusCode = async (
      status: number,
      body: unknown,
      headers?: Record<string, string>,
    ) => {
      const fetchImpl: typeof fetch = async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        });

      const client = new XClient({
        baseUrl: 'https://api.x.com',
        creds,
        timeoutMs: 5000,
        fetchImpl,
      });
      const publisher = new XPublisher({ client, userId: '12345' });

      try {
        await publisher.publish(postWithoutMedia);
        expect.unreachable('Expected publish to throw');
      } catch (err: unknown) {
        return err as PublishError;
      }
    };

    // 503 -> uncertain
    const err503 = await testStatusCode(503, { message: 'Service Unavailable' });
    expect(err503.kind).toBe('uncertain');

    // 403 duplicate content -> uncertain with code duplicate_content
    const err403 = await testStatusCode(403, {
      title: 'Forbidden',
      detail: 'You are not allowed to create a Tweet with duplicate content.',
    });
    expect(err403.kind).toBe('uncertain');
    expect(err403.code).toBe('duplicate_content');

    // 429 -> rate_limited with retryAt
    const futureEpoch = Math.floor(Date.now() / 1000) + 900;
    const err429 = await testStatusCode(
      429,
      { title: 'Too Many Requests' },
      {
        'x-rate-limit-reset': String(futureEpoch),
      },
    );
    expect(err429.kind).toBe('rate_limited');
    expect(err429.retryAt?.getTime()).toBe(futureEpoch * 1000);

    // 401 -> permanent / x_auth
    const err401 = await testStatusCode(401, { title: 'Unauthorized' });
    expect(err401.kind).toBe('permanent');
    expect(err401.code).toBe('x_auth');

    // 400 -> permanent / x_refused
    const err400 = await testStatusCode(400, {
      title: 'Bad Request',
      detail: 'Invalid parameters',
    });
    expect(err400.kind).toBe('permanent');
    expect(err400.code).toBe('x_refused');
  });

  describe('lookup', () => {
    it('returns found when exactly one tweet matches', async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'found-tweet-1',
                text: 'Magnus beats Hikaru in Game 7! https://t.co/xyz',
                created_at: '2026-11-17T12:05:00Z',
                attachments: { media_keys: ['3_123'] },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      const client = new XClient({
        baseUrl: 'https://api.x.com',
        creds,
        timeoutMs: 5000,
        fetchImpl,
      });
      const publisher = new XPublisher({ client, userId: '12345' });

      const res = await publisher.lookup(samplePost, new Date('2026-11-17T12:00:00Z'));
      expect(res.kind).toBe('found');
      if (res.kind === 'found') {
        expect(res.externalId).toBe('found-tweet-1');
      }
    });

    it('returns absent when timeline read succeeds but no tweet matches', async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'other-tweet-2',
                text: 'Unrelated chess news.',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      const client = new XClient({
        baseUrl: 'https://api.x.com',
        creds,
        timeoutMs: 5000,
        fetchImpl,
      });
      const publisher = new XPublisher({ client, userId: '12345' });

      const res = await publisher.lookup(samplePost, new Date('2026-11-17T12:00:00Z'));
      expect(res.kind).toBe('absent');
    });

    it('returns found with the earliest match when multiple tweets match', async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'later-tweet',
                text: 'Magnus beats Hikaru in Game 7!',
                created_at: '2026-11-17T12:10:00Z',
                attachments: { media_keys: ['3_1'] },
              },
              {
                id: 'earlier-tweet',
                text: 'Magnus beats Hikaru in Game 7!',
                created_at: '2026-11-17T12:02:00Z',
                attachments: { media_keys: ['3_2'] },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      const client = new XClient({
        baseUrl: 'https://api.x.com',
        creds,
        timeoutMs: 5000,
        fetchImpl,
      });
      const publisher = new XPublisher({ client, userId: '12345' });

      const res = await publisher.lookup(samplePost, new Date('2026-11-17T12:00:00Z'));
      expect(res.kind).toBe('found');
      if (res.kind === 'found') {
        expect(res.externalId).toBe('earlier-tweet');
      }
    });

    it('returns unknown (never absent) when timeline read fails', async () => {
      const fetchImpl: typeof fetch = async () => new Response('Internal error', { status: 500 });
      const client = new XClient({
        baseUrl: 'https://api.x.com',
        creds,
        timeoutMs: 5000,
        fetchImpl,
      });
      const publisher = new XPublisher({ client, userId: '12345' });

      const res = await publisher.lookup(samplePost, new Date('2026-11-17T12:00:00Z'));
      expect(res.kind).toBe('unknown');
    });
  });

  describe('getStatus', () => {
    it('returns live on 200, deleted on 404, unknown on 500', async () => {
      const makePublisher = (status: number, body?: unknown) => {
        const fetchImpl: typeof fetch = async () =>
          new Response(JSON.stringify(body ?? {}), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        const client = new XClient({
          baseUrl: 'https://api.x.com',
          creds,
          timeoutMs: 5000,
          fetchImpl,
        });
        return new XPublisher({ client, userId: '12345' });
      };

      expect(await makePublisher(200).getStatus('123')).toBe('live');
      expect(await makePublisher(404).getStatus('123')).toBe('deleted');
      expect(
        await makePublisher(200, {
          errors: [{ title: 'Not Found Error', detail: 'Could not find tweet with id: 123' }],
        }).getStatus('123'),
      ).toBe('deleted');
      expect(await makePublisher(500).getStatus('123')).toBe('unknown');
    });
  });
});
