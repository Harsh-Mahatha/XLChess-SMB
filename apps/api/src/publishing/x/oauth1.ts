import crypto from 'node:crypto';
import type { XCredentials } from '../types.js';

/**
 * Percent-encode a string according to RFC 3986 (section 2.1).
 * Encodes all characters except unreserved: A-Z a-z 0-9 - . _ ~
 */
export function rfc3986PercentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface OAuth1HeaderInput {
  method: 'GET' | 'POST';
  url: string; // full URL including query string
  formParams?: Record<string, string>; // only for application/x-www-form-urlencoded bodies
  creds: XCredentials;
  nonce?: string;
  timestamp?: number; // injectable for tests
}

/**
 * Generates an OAuth 1.0a Authorization header (RFC 5849) using HMAC-SHA1.
 * JSON and multipart bodies are never signed per RFC 5849.
 */
export function oauth1Header(input: OAuth1HeaderInput): string {
  const method = input.method.toUpperCase();
  const urlObj = new URL(input.url);

  // Base URL without query or fragment (port stripped if standard 80/443)
  const port =
    (urlObj.protocol === 'https:' && urlObj.port === '443') ||
    (urlObj.protocol === 'http:' && urlObj.port === '80')
      ? ''
      : urlObj.port
        ? `:${urlObj.port}`
        : '';
  const baseUrl = `${urlObj.protocol}//${urlObj.hostname.toLowerCase()}${port}${urlObj.pathname}`;

  const nonce = input.nonce ?? crypto.randomBytes(32).toString('hex');
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: input.creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: input.creds.accessToken,
    oauth_version: '1.0',
  };

  // Collect all parameters: oauth + query params + formParams
  const allParams: Array<{ key: string; value: string }> = [];

  for (const [k, v] of Object.entries(oauthParams)) {
    allParams.push({
      key: rfc3986PercentEncode(k),
      value: rfc3986PercentEncode(v),
    });
  }

  for (const [k, v] of urlObj.searchParams.entries()) {
    allParams.push({
      key: rfc3986PercentEncode(k),
      value: rfc3986PercentEncode(v),
    });
  }

  if (input.formParams) {
    for (const [k, v] of Object.entries(input.formParams)) {
      allParams.push({
        key: rfc3986PercentEncode(k),
        value: rfc3986PercentEncode(v),
      });
    }
  }

  // Sort by encoded key ascending, then by encoded value ascending
  allParams.sort((a, b) => {
    if (a.key === b.key) {
      return a.value.localeCompare(b.value);
    }
    return a.key.localeCompare(b.key);
  });

  const normalizedParams = allParams.map((p) => `${p.key}=${p.value}`).join('&');

  const signatureBaseString = [
    method,
    rfc3986PercentEncode(baseUrl),
    rfc3986PercentEncode(normalizedParams),
  ].join('&');

  const signingKey = `${rfc3986PercentEncode(input.creds.apiSecret)}&${rfc3986PercentEncode(
    input.creds.accessTokenSecret,
  )}`;

  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBaseString)
    .digest('base64');

  // Build Authorization header string
  // Header values are sorted alphabetically
  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const formattedParams = Object.keys(headerParams)
    .sort()
    .map((k) => `${k}="${rfc3986PercentEncode(headerParams[k]!)}"`)
    .join(', ');

  return `OAuth ${formattedParams}`;
}
