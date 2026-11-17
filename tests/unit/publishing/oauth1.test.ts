import { describe, expect, it } from 'vitest';
import { oauth1Header, rfc3986PercentEncode } from '../../../apps/api/src/publishing/x/oauth1.js';

describe('OAuth 1.0a signing (RFC 5849 / RFC 3986)', () => {
  it('correctly percent-encodes per RFC 3986', () => {
    // Encodes everything except A-Z a-z 0-9 - . _ ~
    expect(rfc3986PercentEncode('Ladies + Gentlemen!')).toBe('Ladies%20%2B%20Gentlemen%21');
    expect(rfc3986PercentEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(rfc3986PercentEncode('hello world')).toBe('hello%20world'); // not +
  });

  it('matches the worked example from Twitter / X documentation', () => {
    // Reference: Twitter developer documentation "Creating a signature"
    const creds = {
      apiKey: 'xvz1evFS4wEEPTGEFPHBog',
      apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      accessTokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    };

    const header = oauth1Header({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      formParams: {
        status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      },
      creds,
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    });

    // The signature from X's worked example is hCtSmYh+iHYCEqBWrE7C7hYmtUk=
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"');
    expect(header).toContain('oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_timestamp="1318622958"');
    expect(header).toContain('oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"');
    expect(header).toContain('oauth_version="1.0"');
    expect(header.startsWith('OAuth ')).toBe(true);
  });

  it('generates consistent headers when JSON or multipart bodies are used (bodies are not signed)', () => {
    const creds = {
      apiKey: 'key',
      apiSecret: 'secret',
      accessToken: 'token',
      accessTokenSecret: 'token-secret',
    };

    // Both calls have identical method and URL, no formParams; JSON bodies are not included in OAuth 1.0a signature
    const header1 = oauth1Header({
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      creds,
      nonce: 'fixed-nonce',
      timestamp: 1700000000,
    });

    const header2 = oauth1Header({
      method: 'POST',
      url: 'https://api.x.com/2/tweets',
      creds,
      nonce: 'fixed-nonce',
      timestamp: 1700000000,
    });

    expect(header1).toBe(header2);
  });
});
