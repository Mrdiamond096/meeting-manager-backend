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

const limits = config.rateLimits;

/** Values come from RATE_LIMIT_* (see config.ts; defaults are ADR-013). OTP attempts are capped per challenge in the auth module. */
export const rateLimits = {
  login: () => createRateLimiter({ ...limits.login, key: byIpAndEmail }),
  register: () => createRateLimiter({ ...limits.register, key: byIp }),
  forgotPassword: () => createRateLimiter({ ...limits.forgotPassword, key: byIpAndEmail }),
  // By IP: a per-challenge key would restart on every resend, because each resend issues a new challenge.
  otpResend: () => createRateLimiter({ ...limits.otpResend, key: byIp }),
  // Each successful reset costs a bcrypt hash; the per-challenge attempt cap does not cover that.
  passwordReset: () => createRateLimiter({ ...limits.passwordReset, key: byIp }),
  write: () => createRateLimiter({ ...limits.write, key: byUser }),
};
