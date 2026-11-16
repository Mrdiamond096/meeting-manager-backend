import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import type { AuthUser } from '../../src/http/auth-guard.js';
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
