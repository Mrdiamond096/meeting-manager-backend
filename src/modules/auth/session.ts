import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Executor } from './repository.js';

export const SESSION_COOKIE = 'sid';
/** ADR-009: absolute lifetime of a session (and of its cookie). */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** ADR-009: a session unused for this long is dead. */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** last_seen_at is only rewritten when older than this, to avoid a write on every request. */
export const SESSION_TOUCH_MS = 60 * 1000;

/** randomBytes(32) in base64url. Anything else is not one of ours and is ignored without a query. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

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
  await ex.session.create({
    data: { tokenHash: hashSessionToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt },
  });
  return { token, expiresAt };
}

export interface SessionRecord {
  id: string;
  userId: string;
  role: string;
  lastSeenAt: Date;
  expiresAt: Date;
}

export async function findSession(ex: Executor, token: string): Promise<SessionRecord | undefined> {
  const row = await ex.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true, userId: true, lastSeenAt: true, expiresAt: true, user: { select: { role: true } } },
  });
  if (!row) return undefined;
  return { id: row.id, userId: row.userId, role: row.user.role, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt };
}

/** Both limits must hold: not past the absolute expiry, and not idle for 8 hours. */
export function isSessionActive(session: Pick<SessionRecord, 'lastSeenAt' | 'expiresAt'>, now: Date): boolean {
  return session.expiresAt.getTime() > now.getTime() && session.lastSeenAt.getTime() + SESSION_IDLE_MS > now.getTime();
}

export async function touchSession(ex: Executor, id: string, now: Date): Promise<void> {
  await ex.session.updateMany({ where: { id }, data: { lastSeenAt: now } });
}

export async function deleteSession(ex: Executor, id: string): Promise<void> {
  await ex.session.deleteMany({ where: { id } });
}

export async function deleteSessionByToken(ex: Executor, token: string): Promise<void> {
  await ex.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

/** Reads the `sid` cookie without a cookie-parser dependency. Returns undefined for absent or malformed values. */
export function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
    return TOKEN_FORMAT.test(value) ? value : undefined;
  }
  return undefined;
}

function cookieAttributes(secure: boolean) {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure } as const;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieAttributes(secure), maxAge: SESSION_ABSOLUTE_MS });
}

/** Attributes must match those used when setting the cookie, or the browser keeps the old one. */
export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, cookieAttributes(secure));
}
