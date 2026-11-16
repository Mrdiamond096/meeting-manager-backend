import type { Authenticate, UserRole } from '../../http/auth-guard.js';
import type { ModuleDeps } from '../deps.js';
import {
  deleteSessionIfInactive,
  findSession,
  isSessionActive,
  readSessionToken,
  SESSION_TOUCH_MS,
  touchSession,
} from './session.js';

/**
 * Session authenticator wired in server.ts (ADR-009). Reads the `sid` cookie and, when it maps to a live session
 * (absolute 7 days and idle 8 hours), sets req.user. It never rejects: requireAuth decides what needs a user.
 */
export function createAuthenticate({ db, now }: ModuleDeps): Authenticate {
  return async (req, _res, next) => {
    const token = readSessionToken(req);
    if (!token) return next();

    const at = now();
    let session = await findSession(db, token);
    if (!session) return next();

    if (!isSessionActive(session, at)) {
      if (await deleteSessionIfInactive(db, session.id, at)) return next();
      // Not deleted: a parallel request refreshed it after we read it. Judge the current row, not our copy.
      session = await findSession(db, token);
      if (!session || !isSessionActive(session, at)) return next();
    }
    if (at.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_MS) {
      await touchSession(db, session.id, at);
    }
    req.user = { id: session.userId, role: session.role as UserRole };
    next();
  };
}
