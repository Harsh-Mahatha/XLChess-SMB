import { channelLength } from '@smb/shared';
import type { ApprovedPost } from '../types.js';

/** Returns the text to be posted to X: the post's text trimmed and NFC-normalized. */
export function xText(post: Pick<ApprovedPost, 'text'>): string {
  return post.text.trim().normalize('NFC');
}

/** Computes the character length of text as counted by X (links as 23 characters). */
export function xLength(text: string): number {
  return channelLength('x', text);
}

/**
 * Normalizes post text for comparison against tweets retrieved from X:
 * - Decodes HTML entities (&amp;, &lt;, &gt;, &quot;, &#39;) which X returns escaped
 * - Strips all URLs (including original links and t.co links added by X for media)
 * - Collapses consecutive whitespace to a single space
 * - Trims leading/trailing whitespace
 * - Normalizes Unicode to NFC
 * - Converts to lowercase
 */
export function matchKey(text: string): string {
  const decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const noUrls = decoded.replace(/https?:\/\/\S+/gi, '');
  const collapsed = noUrls.replace(/\s+/g, ' ').trim();
  return collapsed.normalize('NFC').toLowerCase();
}
