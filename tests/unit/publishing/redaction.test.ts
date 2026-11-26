import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../../apps/api/src/logger.js';

describe('logger redaction for publishing secrets', () => {
  it('redacts all sensitive X credentials and authorization headers', () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    const logger = createLogger({ LOG_LEVEL: 'info' }, stream);

    const secrets = {
      X_API_KEY: 'top-secret-api-key',
      X_API_SECRET: 'top-secret-api-secret',
      X_ACCESS_TOKEN: 'top-secret-access-token',
      X_ACCESS_TOKEN_SECRET: 'top-secret-access-token-secret',
      nested: {
        apiSecret: 'nested-api-secret',
        accessTokenSecret: 'nested-token-secret',
        consumerSecret: 'nested-consumer-secret',
        oauth_signature: 'signature-value-secret',
      },
      headers: {
        authorization: 'OAuth oauth_consumer_key="key", oauth_signature="secret-sig"',
        Authorization: 'OAuth oauth_consumer_key="key2", oauth_signature="secret-sig-2"',
      },
      req: {
        headers: {
          authorization: 'OAuth secret-auth-header-value',
        },
      },
    };

    logger.info(secrets, 'publishing attempt log');

    // Verify [REDACTED] appears
    expect(output).toContain('[REDACTED]');

    // Verify none of the secret strings appear in the logged output
    expect(output).not.toContain('top-secret-api-key');
    expect(output).not.toContain('top-secret-api-secret');
    expect(output).not.toContain('top-secret-access-token');
    expect(output).not.toContain('top-secret-access-token-secret');
    expect(output).not.toContain('nested-api-secret');
    expect(output).not.toContain('nested-token-secret');
    expect(output).not.toContain('nested-consumer-secret');
    expect(output).not.toContain('signature-value-secret');
    expect(output).not.toContain('secret-sig');
    expect(output).not.toContain('secret-sig-2');
    expect(output).not.toContain('secret-auth-header-value');
  });

  it('redacts worker tokens, pairing codes, hashes and connection strings', () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ LOG_LEVEL: 'info' }, stream);

    logger.info(
      {
        payload: {
          deviceToken: 'smbw_secret_device_token_12345',
          pairingCode: 'ABCD-EFGH',
          token_hash: 'deadbeef'.repeat(8),
          code_hash: 'cafebabe'.repeat(8),
          connectionString: 'postgresql://user:pass@host/db',
        },
        req: {
          body: {
            pairingCode: 'WXYZ-2345',
            deviceToken: 'smbw_body_device_token_67890',
          },
        },
        DATABASE_URL: 'postgresql://db-secret',
        XLCHESS_JWKS_URL: 'https://jwks.example.com/secret',
      },
      'worker auth log',
    );

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('smbw_secret_device_token_12345');
    expect(output).not.toContain('ABCD-EFGH');
    expect(output).not.toContain('deadbeef'.repeat(8));
    expect(output).not.toContain('cafebabe'.repeat(8));
    expect(output).not.toContain('WXYZ-2345');
    expect(output).not.toContain('smbw_body_device_token_67890');
    expect(output).not.toContain('db-secret');
    expect(output).not.toContain('jwks.example.com/secret');
    expect(output).not.toContain('postgresql://user:pass');
  });
});
