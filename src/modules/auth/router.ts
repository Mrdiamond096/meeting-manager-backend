import { Router } from 'express';
import { config } from '../../config.js';
import { AppError } from '../../http/errors.js';
import { createRateLimits, type RateLimitConfig } from '../../http/rate-limit.js';
import { parseBody } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { createOtpProvider, type OtpProvider } from './otp-provider.js';
import { createPasswordHasher, type PasswordHasher } from './password.js';
import {
  forgotBody,
  loginBody,
  registerBody,
  resendBody,
  resetBody,
  verifyBody,
} from './schemas.js';
import { createAuthService, type IssuedChallenge } from './service.js';
import type { UserRow } from './repository.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './session.js';

export interface AuthRouterOptions {
  rateLimitConfig?: RateLimitConfig;
  /** Defaults to a provider built from config (mock in this project). */
  otpProvider?: OtpProvider;
  /** bcrypt cost; defaults to 12 (ADR-009). Tests lower it for speed. Ignored when passwordHasher is given. */
  bcryptCost?: number;
  passwordHasher?: PasswordHasher;
  /** Defaults to COOKIE_SECURE. */
  cookieSecure?: boolean;
}

const challengeDto = ({ challengeId, expiresAt }: IssuedChallenge) => ({
  challengeId,
  expiresAt: expiresAt.toISOString(),
});

export const userDto = (user: Pick<UserRow, 'id' | 'email' | 'role'>) => ({
  id: user.id,
  email: user.email,
  role: user.role,
});

export function authRouter(deps: ModuleDeps, options: AuthRouterOptions = {}): Router {
  const service = createAuthService({
    ...deps,
    otp: options.otpProvider ?? createOtpProvider(config.otp),
    hasher: options.passwordHasher ?? createPasswordHasher(options.bcryptCost),
  });
  const cookieSecure = options.cookieSecure ?? config.cookieSecure;
  const router = Router({ mergeParams: true });
  const rateLimits = createRateLimits(options.rateLimitConfig ?? config);

  router.post('/register', rateLimits.register(), async (req, res) => {
    const body = parseBody(registerBody, req);
    res.status(201).json(challengeDto(await service.register(body)));
  });

  router.post('/login', rateLimits.login(), async (req, res) => {
    const body = parseBody(loginBody, req);
    res.json(challengeDto(await service.login(body)));
  });

  router.post('/otp/verify', async (req, res) => {
    const body = parseBody(verifyBody, req);
    const { user, session } = await service.verifyOtp(req.log, body);
    setSessionCookie(res, session.token, cookieSecure);
    res.json({ user: userDto(user) });
  });

  // The IP backstop remains stable across challenge replacements; the service enforces the per-user budget.
  router.post('/otp/resend', rateLimits.otpResend(), async (req, res) => {
    const body = parseBody(resendBody, req);
    res.json(challengeDto(await service.resend(body)));
  });

  router.post('/password/forgot', rateLimits.forgotPassword(), async (req, res) => {
    const body = parseBody(forgotBody, req);
    res.status(202).json(challengeDto(await service.forgotPassword(req.log, body)));
  });

  router.post('/password/reset', rateLimits.passwordReset(), async (req, res) => {
    const body = parseBody(resetBody, req);
    await service.resetPassword(req.log, body);
    res.status(204).end();
  });

  router.post('/logout', async (req, res) => {
    await service.logout(readSessionToken(req));
    clearSessionCookie(res, cookieSecure);
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    const user = await service.currentUser(req.user.id);
    res.set('Cache-Control', 'no-store').json({ user: userDto(user) });
  });

  return router;
}
