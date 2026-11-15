import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (ADR-009): non-safe requests that carry an Origin header must come from an allowed origin.
 * Requests without Origin (curl, server-to-server, tests) pass; SameSite=Lax already keeps the cookie off cross-site posts.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (SAFE_METHODS.has(req.method) || !origin || allowed.has(origin)) return next();
    next(new AppError('ORIGIN_NOT_ALLOWED'));
  };
}
