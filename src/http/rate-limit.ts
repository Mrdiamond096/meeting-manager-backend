import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import { AppError } from './errors.js';

interface LimiterOptions {
  enabled: boolean;
  windowMs: number;
  limit: number;
  key: (req: Request) => string;
}

export function createRateLimiter({
  enabled,
  windowMs,
  limit,
  key,
}: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
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

export type RateLimitConfig = Pick<Config, 'rateLimitEnabled' | 'rateLimits'>;

/** Each factory owns its settings and creates independent stores for each mounted limiter. */
export function createRateLimits({
  rateLimitEnabled: enabled,
  rateLimits: limits,
}: RateLimitConfig) {
  const factory = (setting: { windowMs: number; limit: number }, key: LimiterOptions['key']) => {
    const options = { ...setting, key, enabled };
    return () => createRateLimiter(options);
  };
  return {
    login: factory(limits.login, byIpAndEmail),
    register: factory(limits.register, byIp),
    forgotPassword: factory(limits.forgotPassword, byIpAndEmail),
    // An IP key remains stable when resend issues a new challenge id.
    otpResend: factory(limits.otpResend, byIp),
    passwordReset: factory(limits.passwordReset, byIp),
    write: factory(limits.write, byUser),
  };
}
