import { hash } from 'bcryptjs';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import type { AuthUser } from '../../src/http/auth-guard.js';
import { createAuthenticate } from '../../src/modules/auth/authenticate.js';
import { createUser, testDb } from './db.js';

interface TestAppOptions {
  /** Stub session: every request is authenticated as this user. */
  user?: AuthUser;
  now?: () => Date;
  pingDb?: () => Promise<void>;
}

export function createTestApp(options: TestAppOptions = {}): Express {
  const { user } = options;
  return createApp({
    db: testDb,
    pingDb: options.pingDb ?? (async () => {}),
    now: options.now,
    authenticate: user
      ? (req, _res, next) => {
          req.user = user;
          next();
        }
      : undefined,
  });
}

/** Creates a real user row and an app authenticated as that user (stubbed session, no cookie/OTP). */
export async function loginAs(options: Omit<TestAppOptions, 'user'> = {}) {
  const row = await createUser();
  const user: AuthUser = { id: row.id, role: row.role as AuthUser['role'] };
  return { app: createTestApp({ ...options, user }), user };
}

/**
 * Signs in through the real flow (login, OTP, session cookie) instead of stubbing `authenticate`.
 * Use it when a test must prove that the real guard accepts a real session; `loginAs()` stays the fast path.
 */
export async function loginViaApi(options: Omit<TestAppOptions, 'user'> & { password?: string } = {}) {
  const password = options.password ?? 'correct horse battery';
  // Cost 4 keeps the hash cheap; bcrypt reads the cost from the hash, so the real login path is unchanged.
  const row = await createUser({ passwordHash: await hash(password, 4) });
  const now = options.now ?? (() => new Date());
  const app = createApp({
    db: testDb,
    pingDb: options.pingDb ?? (async () => {}),
    now,
    authenticate: createAuthenticate({ db: testDb, now }),
  });

  const login = await request(app).post('/api/v1/auth/login').send({ email: row.email, password });
  if (login.status !== 200) throw new Error(`login failed with ${login.status}`);
  const verified = await request(app)
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId: login.body.challengeId, code: config.otp.mockCode });
  if (verified.status !== 200) throw new Error(`otp verify failed with ${verified.status}`);

  const setCookie = verified.headers['set-cookie'] as unknown as string[];
  const cookie = setCookie.find((c) => c.startsWith('sid='))!.split(';')[0]!;
  const user: AuthUser = { id: row.id, role: row.role as AuthUser['role'] };
  return { app, user, email: row.email, password, cookie };
}
