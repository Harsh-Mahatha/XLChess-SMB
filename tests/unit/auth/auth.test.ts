import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { actorOf, authenticate, requireRole } from '../../../apps/api/src/auth/middleware.js';
import { createTokenVerifier } from '../../../apps/api/src/auth/verify.js';
import { errorHandler } from '../../../apps/api/src/http/errors.js';

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret');
const verifier = createTokenVerifier({
  alg: 'HS256',
  key: secret,
  issuer: 'xlchess',
  audience: 'smb',
  userIdClaim: 'sub',
});

async function token(
  claims: Record<string, unknown> = { smb_role: 'reviewer' },
  opts: {
    issuer?: string;
    audience?: string;
    sub?: string | null;
    iat?: number;
    exp?: string;
  } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.issuer ?? 'xlchess')
    .setAudience(opts.audience ?? 'smb')
    .setIssuedAt(opts.iat)
    .setExpirationTime(opts.exp ?? '60s');
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? 'user-1');
  return jwt.sign(secret);
}

describe('token verification', () => {
  it('accepts a valid token and reads the user and role', async () => {
    expect(await verifier.verify(await token())).toEqual({ userId: 'user-1', role: 'reviewer' });
    expect(await verifier.verify(await token({ smb_role: 'admin' }))).toMatchObject({
      role: 'admin',
    });
  });

  it('refuses a wrong issuer, audience, signature or an expired token', async () => {
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { issuer: 'other' })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { audience: 'other' })),
    ).rejects.toMatchObject({ status: 401 });
    const forged = await new SignJWT({ smb_role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('xlchess')
      .setAudience('smb')
      .setSubject('u')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new TextEncoder().encode('another-secret-another-secret-aaaa'));
    await expect(verifier.verify(forged)).rejects.toMatchObject({ status: 401 });
    const past = Math.floor(Date.now() / 1000) - 600;
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { iat: past, exp: '-1s' })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a token issued over five minutes ago, or one with no user id', async () => {
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { exp: '2h' })),
    ).resolves.toBeDefined();
    const old = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { iat: old, exp: '2h' })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifier.verify(await token({ smb_role: 'admin' }, { sub: null })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an account with no SMB role, or a role it does not know', async () => {
    await expect(verifier.verify(await token({}))).rejects.toMatchObject({ status: 403 });
    await expect(verifier.verify(await token({ smb_role: 'viewer' }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(verifier.verify(await token({ smb_role: 'superuser' }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses a token signed with a different algorithm', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u","smb_role":"admin"}').toString('base64url')}.`;
    await expect(verifier.verify(none)).rejects.toMatchObject({ status: 401 });
  });
});

describe('middleware', () => {
  const app = (v: typeof verifier | undefined) => {
    const a = express();
    a.get('/reviewer', authenticate(v), requireRole('reviewer', 'admin'), (_req, res) => {
      res.json({ ok: true, actor: actorOf(res) });
    });
    a.get('/admin', authenticate(v), requireRole('admin'), (_req, res) => res.json({ ok: true }));
    a.use(errorHandler);
    return a;
  };

  it('answers 401 without a bearer token, and 401 for a worker-style opaque token', async () => {
    await request(app(verifier)).get('/reviewer').expect(401);
    await request(app(verifier))
      .get('/reviewer')
      .set('Authorization', 'Bearer abcdef0123456789')
      .expect(401);
    await request(app(verifier)).get('/reviewer').set('Authorization', 'Basic abc').expect(401);
  });

  it('lets the right roles through and refuses the wrong one', async () => {
    const reviewer = await token({ smb_role: 'reviewer' });
    const admin = await token({ smb_role: 'admin' });
    await request(app(verifier))
      .get('/reviewer')
      .set('Authorization', `Bearer ${reviewer}`)
      .expect(200);
    await request(app(verifier))
      .get('/admin')
      .set('Authorization', `Bearer ${reviewer}`)
      .expect(403);
    await request(app(verifier)).get('/admin').set('Authorization', `Bearer ${admin}`).expect(200);
  });

  it('answers 503, not "open", when sign-in is not configured', async () => {
    const res = await request(app(undefined)).get('/reviewer').expect(503);
    expect(res.body.error.code).toBe('auth_not_configured');
  });
});
