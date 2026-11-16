import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../env.js';

/**
 * What a reviewer or administrator may do in SMB. XLChess decides who holds which role and puts the result in
 * the token it mints for each call (`smb_role`): its MANAGER becomes `reviewer` and its ADMIN becomes `admin`.
 * SMB never stores or guesses roles of its own for these routes.
 */
export const SMB_ROLES = ['reviewer', 'admin'] as const;
export type SmbRole = (typeof SMB_ROLES)[number];

export interface Actor {
  /** The XLChess user id (the token's user-id claim). */
  userId: string;
  role: SmbRole;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<Actor>;
}

/** The longest a token may live. XLChess mints one per call, so a stolen token is useful only briefly. */
export const MAX_TOKEN_AGE = '5m';

type KeySource = Uint8Array | JWTVerifyGetKey;

export interface VerifierOptions {
  alg: 'HS256' | 'RS256';
  key: KeySource;
  issuer: string;
  audience: string;
  userIdClaim: string;
}

export function createTokenVerifier(opts: VerifierOptions): TokenVerifier {
  return {
    async verify(token: string): Promise<Actor> {
      let payload;
      try {
        const verify = (key: KeySource) =>
          typeof key === 'function'
            ? jwtVerify(token, key, verifyOptions(opts))
            : jwtVerify(token, key, verifyOptions(opts));
        ({ payload } = await verify(opts.key));
      } catch {
        // Never say why: a bad signature, an expired token and a wrong audience look the same to a caller.
        throw new AuthError(
          401,
          'invalid_token',
          'The access token is missing, expired or invalid',
        );
      }
      const userId = payload[opts.userIdClaim];
      if (typeof userId !== 'string' || userId === '') {
        throw new AuthError(401, 'invalid_token', 'The access token has no user id');
      }
      const role = payload['smb_role'];
      if (role !== 'reviewer' && role !== 'admin') {
        throw new AuthError(403, 'forbidden', 'This account has no SMB role');
      }
      return { userId, role };
    },
  };
}

function verifyOptions(opts: VerifierOptions) {
  return {
    algorithms: [opts.alg],
    issuer: opts.issuer,
    audience: opts.audience,
    maxTokenAge: MAX_TOKEN_AGE,
    requiredClaims: ['exp', 'iat'],
  };
}

/**
 * Builds the verifier from the environment, or returns undefined when authentication is not configured
 * (then every /v1 reviewer route answers 503 rather than letting anyone in).
 */
export function verifierFromEnv(env: Env): TokenVerifier | undefined {
  if (!env.XLCHESS_JWT_ISSUER || !env.XLCHESS_JWT_AUDIENCE) return undefined;
  let key: KeySource | undefined;
  if (env.XLCHESS_JWT_ALG === 'HS256') {
    if (env.XLCHESS_JWT_SECRET) key = new TextEncoder().encode(env.XLCHESS_JWT_SECRET);
  } else if (env.XLCHESS_JWKS_URL) {
    key = createRemoteJWKSet(new URL(env.XLCHESS_JWKS_URL));
  }
  if (!key) return undefined;
  return createTokenVerifier({
    alg: env.XLCHESS_JWT_ALG,
    key,
    issuer: env.XLCHESS_JWT_ISSUER,
    audience: env.XLCHESS_JWT_AUDIENCE,
    userIdClaim: env.XLCHESS_JWT_USER_ID_CLAIM,
  });
}
