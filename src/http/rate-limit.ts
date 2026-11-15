import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { AppError } from './errors.js';

interface LimiterOptions {
  windowMs: number;
  limit: number;
  key: (req: Request) => string;
}

export function createRateLimiter({ windowMs, limit, key }: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !config.rateLimitEnabled,
    keyGenerator: key,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED')),
  });
}

export const byIp = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

export const byIpAndEmail = (req: Request) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `${byIp(req)}|${email}`;
};

export const byUser = (req: Request) => req.user?.id ?? byIp(req);

const MINUTE = 60_000;

/** Limits from ADR-013. OTP attempts are enforced per challenge in the auth module, not here. */
export const rateLimits = {
  login: () => createRateLimiter({ windowMs: 15 * MINUTE, limit: 5, key: byIpAndEmail }),
  register: () => createRateLimiter({ windowMs: 60 * MINUTE, limit: 3, key: byIp }),
  forgotPassword: () => createRateLimiter({ windowMs: 60 * MINUTE, limit: 3, key: byIpAndEmail }),
  write: () => createRateLimiter({ windowMs: MINUTE, limit: 60, key: byUser }),
};
