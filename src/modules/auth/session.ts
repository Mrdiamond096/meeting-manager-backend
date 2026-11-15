import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { sessions } from '../../db/schema/index.js';
import type { Executor } from './repository.js';

export const SESSION_COOKIE = 'sid';
/** ADR-009: absolute lifetime of a session (and of its cookie). */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

/** The database only ever sees this hash; the raw token lives in the cookie. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  ex: Executor,
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await ex.insert(sessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: SESSION_ABSOLUTE_MS,
  });
}
