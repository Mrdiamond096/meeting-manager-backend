import type { RequestHandler } from 'express';
import type { USER_ROLES } from '../db/constants.js';
import { AppError } from './errors.js';

export type UserRole = (typeof USER_ROLES)[number];

export interface AuthUser {
  id: string;
  role: UserRole;
}

/**
 * Populates req.user from the session cookie, or leaves it undefined.
 * The auth module provides the session implementation; tests may inject a stub.
 */
export type Authenticate = RequestHandler;

export const anonymous: Authenticate = (_req, _res, next) => next();

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new AppError('UNAUTHENTICATED'));
};

export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError('UNAUTHENTICATED'));
    next(roles.includes(req.user.role) ? undefined : new AppError('FORBIDDEN'));
  };
