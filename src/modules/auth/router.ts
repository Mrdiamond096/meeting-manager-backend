import { Router } from 'express';
import { config } from '../../config.js';
import { byIp, createRateLimiter, rateLimits } from '../../http/rate-limit.js';
import { parseBody } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { createOtpProvider, type OtpProvider } from './otp-provider.js';
import { createPasswordHasher } from './password.js';
import { registerBody, resendBody, verifyBody } from './schemas.js';
import { createAuthService, type IssuedChallenge } from './service.js';
import type { UserRow } from './repository.js';
import { setSessionCookie } from './session.js';

export interface AuthRouterOptions {
  /** Defaults to a provider built from config (mock in this project). */
  otpProvider?: OtpProvider;
  /** bcrypt cost; defaults to 12 (ADR-009). Tests lower it for speed. */
  bcryptCost?: number;
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
    hasher: createPasswordHasher(options.bcryptCost),
  });
  const cookieSecure = options.cookieSecure ?? config.cookieSecure;
  const router = Router({ mergeParams: true });

  // Backstop keyed by IP (stable across the new id every resend returns). The per-user budget lives in the service.
  // rateLimits.otpResend() is keyed by challenge id and restarts on every resend, so it is not used here.
  const resendByIp = createRateLimiter({ windowMs: 15 * 60_000, limit: 10, key: byIp });

  router.post('/register', rateLimits.register(), async (req, res) => {
    const body = parseBody(registerBody, req);
    res.status(201).json(challengeDto(await service.register(body)));
  });

  router.post('/otp/verify', async (req, res) => {
    const body = parseBody(verifyBody, req);
    const { user, session } = await service.verifyOtp(req.log, body);
    setSessionCookie(res, session.token, cookieSecure);
    res.json({ user: userDto(user) });
  });

  router.post('/otp/resend', resendByIp, async (req, res) => {
    const body = parseBody(resendBody, req);
    res.json(challengeDto(await service.resend(body)));
  });

  return router;
}
