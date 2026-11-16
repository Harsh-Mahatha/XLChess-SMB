import { channelLength, type ChannelsRegistry } from '@smb/shared';

export interface ChannelPreview {
  channel: string;
  name: string;
  /** False while the channel is switched off in config/channels.json (V1 posts to X only). */
  enabled: boolean;
  /** The text this channel would post: its own text, or the caption when the channel has none. */
  text: string;
  length: number;
  limit: number;
  hasOwnText: boolean;
  hasImage: boolean;
  altText: string | null;
  /** Everything that would stop this channel from posting this revision. Empty means it fits. */
  problems: string[];
}

export interface PreviewInput {
  caption: string;
  channelTexts: Record<string, unknown>;
  altText?: string | null;
  /** True when the revision has, or will get at approval, a graphic. */
  hasGraphic: boolean;
}

/** How each channel would show a revision, and whether it fits that channel's rules. */
export function channelPreviews(registry: ChannelsRegistry, input: PreviewInput): ChannelPreview[] {
  return registry.channels.map((spec) => {
    const own = input.channelTexts[spec.id];
    const hasOwnText = typeof own === 'string' && own.trim() !== '';
    const text = hasOwnText ? (own as string) : input.caption;
    const length = channelLength(spec.id, text);
    const altText = input.altText?.trim() ? input.altText : null;
    const problems: string[] = [];
    if (length > spec.maxTextLength) {
      problems.push(`${length} characters; ${spec.name} allows ${spec.maxTextLength}`);
    }
    if (text.trim() === '') problems.push('no text');
    if (spec.mediaRequired && !input.hasGraphic) problems.push(`${spec.name} needs an image`);
    if (spec.altTextRequired && input.hasGraphic && !altText) {
      problems.push(`${spec.name} needs alt text for the image`);
    }
    return {
      channel: spec.id,
      name: spec.name,
      enabled: spec.enabled,
      text,
      length,
      limit: spec.maxTextLength,
      hasOwnText,
      hasImage: input.hasGraphic,
      altText,
      problems,
    };
  });
}
