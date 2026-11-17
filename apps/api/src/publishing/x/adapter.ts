import { matchKey, xLength, xText } from './text.js';
import { XClient, XRequestError } from './client.js';
import {
  ApprovedPost,
  LookupResult,
  PublishError,
  PublishResult,
  SocialPublisher,
  ValidationResult,
} from '../types.js';

export interface XPublisherOptions {
  client: XClient;
  userId: string;
  username?: string;
  now?: () => Date;
  reconcileWindowMinutes?: number;
}

/** Pure validation function for an X post, shared between XPublisher and DryRunPublisher. */
export function validateXPost(post: ApprovedPost): ValidationResult {
  const problems: string[] = [];

  if (post.channel !== 'x') {
    problems.push(`channel must be 'x', got '${post.channel}'`);
  }

  const trimmedText = post.text.trim();
  if (trimmedText.length === 0) {
    problems.push('post text cannot be empty');
  }

  const length = xLength(post.text);
  if (length > 280) {
    problems.push(`post text length is ${length}, exceeding X limit of 280 characters`);
  }

  if (post.media.length > 4) {
    problems.push(`too many media attachments (${post.media.length}); X allows at most 4`);
  }

  for (let i = 0; i < post.media.length; i++) {
    const item = post.media[i]!;
    if (item.mime !== 'image/png' && item.mime !== 'image/jpeg') {
      problems.push(
        `media item ${i + 1} has unsupported mime type '${item.mime}'; X requires image/png or image/jpeg`,
      );
    }
    if (item.bytes.length > 5 * 1024 * 1024) {
      problems.push(`media item ${i + 1} size ${item.bytes.length} bytes exceeds 5 MB limit`);
    }
    if (!item.altText || item.altText.trim().length === 0) {
      problems.push(`media item ${i + 1} is missing required alt text`);
    } else if (item.altText.length > 1000) {
      problems.push(
        `media item ${i + 1} alt text length ${item.altText.length} exceeds 1000 characters`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
  };
}

export class XPublisher implements SocialPublisher {
  readonly channel = 'x' as const;
  private readonly client: XClient;
  private readonly userId: string;
  private readonly username?: string;
  private readonly now: () => Date;

  constructor(options: XPublisherOptions) {
    this.client = options.client;
    this.userId = options.userId;
    this.username = options.username;
    this.now = options.now ?? (() => new Date());
  }

  private buildPostUrl(id: string): string {
    return this.username
      ? `https://x.com/${this.username}/status/${id}`
      : `https://x.com/i/web/status/${id}`;
  }

  validate(post: ApprovedPost): ValidationResult {
    return validateXPost(post);
  }

  async publish(post: ApprovedPost, signal?: AbortSignal): Promise<PublishResult> {
    const validation = this.validate(post);
    if (!validation.ok) {
      throw new PublishError(
        'permanent',
        'invalid_post',
        `Post validation failed: ${validation.problems.join('; ')}`,
        undefined,
        { problems: validation.problems },
      );
    }

    const uploadedMediaIds: string[] = [];

    // Step 1: Upload media
    for (let i = 0; i < post.media.length; i++) {
      const mediaItem = post.media[i]!;
      const ext = mediaItem.mime === 'image/png' ? 'png' : 'jpg';

      const formData = new FormData();
      formData.append(
        'media',
        new Blob([Buffer.from(mediaItem.bytes)], { type: mediaItem.mime }),
        `image-${i + 1}.${ext}`,
      );
      formData.append('media_category', 'tweet_image');

      let uploadRes;
      try {
        uploadRes = await this.client.postMultipart('/2/media/upload', formData, signal);
      } catch (err: unknown) {
        const error = err as Error;
        throw new PublishError(
          'before_send',
          'media_upload_failed',
          `Network error uploading media: ${error.message}`,
        );
      }

      if (uploadRes.status === 429) {
        const resetHeader = uploadRes.headers.get('x-rate-limit-reset');
        let retryAt: Date | undefined;
        if (resetHeader) {
          const resetEpoch = parseInt(resetHeader, 10);
          if (!isNaN(resetEpoch)) {
            retryAt = new Date(resetEpoch * 1000);
          }
        }
        if (!retryAt) {
          retryAt = new Date(this.now().getTime() + 15 * 60 * 1000);
        }
        throw new PublishError(
          'rate_limited',
          'rate_limited',
          'X rate limit exceeded on media upload',
          retryAt,
        );
      }

      if (uploadRes.status < 200 || uploadRes.status >= 300) {
        throw new PublishError(
          'before_send',
          'media_upload_failed',
          `Media upload failed with HTTP status ${uploadRes.status}`,
          undefined,
          { status: uploadRes.status },
        );
      }

      const mediaBody = uploadRes.body as Record<string, unknown> | null;
      const mediaData = mediaBody?.data as Record<string, unknown> | undefined;
      const mediaId = mediaData?.id ?? mediaBody?.media_id_string ?? mediaBody?.media_id;
      if (!mediaId) {
        throw new PublishError(
          'before_send',
          'media_upload_failed',
          'Media upload response did not include a media ID',
        );
      }

      uploadedMediaIds.push(String(mediaId));

      // Step 2: Set alt text
      if (mediaItem.altText) {
        let metaRes;
        try {
          metaRes = await this.client.postJson(
            '/2/media/metadata',
            {
              id: String(mediaId),
              metadata: {
                alt_text: {
                  text: mediaItem.altText,
                },
              },
            },
            signal,
          );
        } catch (err: unknown) {
          const error = err as Error;
          throw new PublishError(
            'before_send',
            'media_metadata_failed',
            `Network error setting media metadata: ${error.message}`,
          );
        }

        if (metaRes.status < 200 || metaRes.status >= 300) {
          throw new PublishError(
            'before_send',
            'media_metadata_failed',
            `Setting media alt text failed with HTTP status ${metaRes.status}`,
            undefined,
            { status: metaRes.status },
          );
        }
      }
    }

    // Step 3: Create post
    const tweetPayload: Record<string, unknown> = {
      text: xText(post),
    };
    if (uploadedMediaIds.length > 0) {
      tweetPayload.media = {
        media_ids: uploadedMediaIds,
      };
    }

    let tweetRes;
    try {
      tweetRes = await this.client.postJson('/2/tweets', tweetPayload, signal);
    } catch (err: unknown) {
      const error = err as Error;
      // Any timeout, abort or network error on create post is UNCERTAIN
      throw new PublishError(
        'uncertain',
        'create_uncertain',
        `Create post call failed with network or timeout error: ${error.message}`,
        undefined,
        { isTimeout: (err as XRequestError).isTimeout },
      );
    }

    // Process HTTP response
    if (tweetRes.status === 201 || tweetRes.status === 200) {
      const responseBody = tweetRes.body as Record<string, unknown> | null;
      const tweetData = (responseBody?.data ?? responseBody) as Record<string, unknown> | undefined;
      const externalId = String(tweetData?.id ?? responseBody?.id_str);
      const returnedText = String(tweetData?.text ?? post.text);
      const publishedAt = this.now();
      const url = this.buildPostUrl(externalId);

      return {
        kind: 'published',
        externalId,
        url,
        publishedAt,
        response: {
          id: externalId,
          text: returnedText,
        },
      };
    }

    // 5xx -> uncertain
    if (tweetRes.status >= 500) {
      throw new PublishError(
        'uncertain',
        'create_uncertain',
        `X server error (${tweetRes.status}) creating post`,
        undefined,
        { status: tweetRes.status },
      );
    }

    // 429 -> rate_limited
    if (tweetRes.status === 429) {
      const resetHeader = tweetRes.headers.get('x-rate-limit-reset');
      let retryAt: Date | undefined;
      if (resetHeader) {
        const resetEpoch = parseInt(resetHeader, 10);
        if (!isNaN(resetEpoch)) {
          retryAt = new Date(resetEpoch * 1000);
        }
      }
      if (!retryAt) {
        retryAt = new Date(this.now().getTime() + 15 * 60 * 1000);
      }
      throw new PublishError(
        'rate_limited',
        'rate_limited',
        'X rate limit exceeded on create post',
        retryAt,
      );
    }

    // 403 duplicate -> uncertain
    const responseString = JSON.stringify(tweetRes.body ?? {}).toLowerCase();
    if (tweetRes.status === 403 && responseString.includes('duplicate')) {
      throw new PublishError(
        'uncertain',
        'duplicate_content',
        'X refused post as duplicate content; may have succeeded previously',
        undefined,
        { status: 403 },
      );
    }

    // 401 -> permanent auth failure
    if (tweetRes.status === 401) {
      throw new PublishError('permanent', 'x_auth', 'X authentication failed (401)', undefined, {
        status: 401,
      });
    }

    // Other 4xx -> permanent refusal
    const errorDetails = tweetRes.body as Record<string, unknown> | null;
    const detailMsg = String(
      errorDetails?.detail ?? errorDetails?.title ?? `HTTP ${tweetRes.status}`,
    );
    throw new PublishError('permanent', 'x_refused', `X refused post: ${detailMsg}`, undefined, {
      status: tweetRes.status,
      detail: detailMsg,
    });
  }

  async lookup(post: ApprovedPost, since: Date): Promise<LookupResult> {
    try {
      const startTime = new Date(since.getTime() - 2 * 60 * 1000).toISOString();
      const targetKey = matchKey(post.text);
      const hasMedia = post.media.length > 0;

      let nextToken: string | undefined;
      let pages = 0;
      const matchedTweets: Array<{ id: string; text: string; created_at?: string }> = [];

      do {
        pages++;
        const query: Record<string, string> = {
          start_time: startTime,
          max_results: '100',
          'tweet.fields': 'created_at,attachments',
          exclude: 'retweets,replies',
        };
        if (nextToken) {
          query.pagination_token = nextToken;
        }

        const res = await this.client.get(`/2/users/${this.userId}/tweets`, query);
        if (res.status !== 200) {
          return {
            kind: 'unknown',
            reason: `Lookup timeline request returned HTTP ${res.status}`,
          };
        }

        const body = res.body as {
          data?: Array<{
            id: string;
            text?: string;
            created_at?: string;
            attachments?: { media_keys?: string[] };
          }>;
          meta?: { next_token?: string };
        } | null;
        const tweets = body?.data ?? [];

        for (const tweet of tweets) {
          if (matchKey(tweet.text ?? '') === targetKey) {
            if (hasMedia) {
              const mediaKeys = tweet.attachments?.media_keys ?? [];
              if (mediaKeys.length > 0) {
                matchedTweets.push({
                  id: tweet.id,
                  text: tweet.text ?? '',
                  created_at: tweet.created_at,
                });
              }
            } else {
              matchedTweets.push({
                id: tweet.id,
                text: tweet.text ?? '',
                created_at: tweet.created_at,
              });
            }
          }
        }

        nextToken = body?.meta?.next_token;
      } while (nextToken && pages < 3);

      if (matchedTweets.length === 1) {
        const found = matchedTweets[0]!;
        const publishedAt = found.created_at ? new Date(found.created_at) : this.now();
        return {
          kind: 'found',
          externalId: found.id,
          url: this.buildPostUrl(found.id),
          publishedAt,
        };
      }

      if (matchedTweets.length > 1) {
        // Sort by created_at ascending (earliest first)
        matchedTweets.sort((a, b) => {
          const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return tA - tB;
        });
        const earliest = matchedTweets[0]!;
        const publishedAt = earliest.created_at ? new Date(earliest.created_at) : this.now();
        return {
          kind: 'found',
          externalId: earliest.id,
          url: this.buildPostUrl(earliest.id),
          publishedAt,
        };
      }

      return { kind: 'absent' };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        kind: 'unknown',
        reason: `Lookup request failed: ${error.message}`,
      };
    }
  }

  async getStatus(externalId: string): Promise<'live' | 'deleted' | 'unknown'> {
    try {
      const res = await this.client.get(`/2/tweets/${externalId}`);
      if (res.status === 404) {
        return 'deleted';
      }
      const body = res.body as { errors?: Array<{ title?: string; detail?: string }> } | null;
      if (body?.errors && Array.isArray(body.errors)) {
        const notFound = body.errors.some(
          (e) =>
            e.title === 'Not Found Error' ||
            (typeof e.detail === 'string' && e.detail.toLowerCase().includes('not found')),
        );
        if (notFound) {
          return 'deleted';
        }
      }
      if (res.status === 200) {
        return 'live';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
