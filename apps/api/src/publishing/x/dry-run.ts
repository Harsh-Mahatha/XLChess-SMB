import { validateXPost } from './adapter.js';
import { xLength, xText } from './text.js';
import {
  ApprovedPost,
  LookupResult,
  PublishError,
  PublishResult,
  SocialPublisher,
  ValidationResult,
} from '../types.js';

export class DryRunPublisher implements SocialPublisher {
  readonly channel = 'x' as const;

  validate(post: ApprovedPost): ValidationResult {
    return validateXPost(post);
  }

  async publish(post: ApprovedPost): Promise<PublishResult> {
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

    const text = xText(post);
    const length = xLength(text);

    return {
      kind: 'dry_run',
      request: {
        channel: post.channel,
        text,
        length,
        media: post.media.map((m) => ({
          assetId: m.assetId,
          sha256: m.sha256,
          bytes: m.bytes.length,
          mime: m.mime,
          altText: m.altText,
        })),
      },
    };
  }

  async lookup(): Promise<LookupResult> {
    return { kind: 'absent' };
  }

  async getStatus(): Promise<'live' | 'deleted' | 'unknown'> {
    return 'unknown';
  }
}
