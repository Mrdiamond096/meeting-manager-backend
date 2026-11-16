import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import express, { type Express } from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { errorHandler, notFoundHandler } from '../../src/http/error-handler.js';
import { createAuthenticate } from '../../src/modules/auth/authenticate.js';
import { authRouter, type AuthRouterOptions } from '../../src/modules/auth/router.js';
import { REDACT_PATHS } from '../../src/observability/logger.js';
import { testDb } from '../helpers/db.js';

export const OTP = '112233';
export const PASSWORD = 'correct horse battery';
const BASE = '/api/v1/auth';

/** Controllable clock so TTL / expiry tests do not sleep. */
export function createClock(start = new Date('2026-11-20T10:00:00.000Z')) {
  let ms = start.getTime();
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
}

/** Real pino pipeline (same redact list as production) writing to memory so tests can assert on log output. */
export function createLogCapture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const logger = pino({ level: 'trace', redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
  const text = () => chunks.join('');
  return {
    logger,
    text,
    records: () =>
      text()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface AuthAppOptions extends AuthRouterOptions {
  now: () => Date;
  logger?: ReturnType<typeof createLogCapture>['logger'];
}

/** Real session authenticate + auth router on a minimal app, with the real error handler. bcrypt cost 4 keeps tests fast. */
export function createAuthApp({ now, logger, ...router }: AuthAppOptions): Express {
  const app = express();
  if (logger) app.use(pinoHttp({ logger }));
  else app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use(express.json());
  app.use(BASE, createAuthenticate({ db: testDb, now }));
  app.use(BASE, authRouter({ db: testDb, now }, { bcryptCost: 4, ...router }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * supertest starts a throwaway server per `request(app)`. Firing dozens at once makes the occasional response
 * never arrive (about 1 run in 10), so concurrent tests talk to one long-lived server instead.
 */
export function serve(app: Express): Server {
  return createServer(app).listen(0);
}

export type Target = Express | Server;

export const api = (app: Target) => ({
  register: (body: unknown) => request(app).post(`${BASE}/register`).send(body as object),
  login: (body: unknown) => request(app).post(`${BASE}/login`).send(body as object),
  verify: (body: unknown) => request(app).post(`${BASE}/otp/verify`).send(body as object),
  resend: (body: unknown) => request(app).post(`${BASE}/otp/resend`).send(body as object),
  forgot: (body: unknown) => request(app).post(`${BASE}/password/forgot`).send(body as object),
  reset: (body: unknown) => request(app).post(`${BASE}/password/reset`).send(body as object),
  me: (cookie?: string) => request(app).get(`${BASE}/me`).set('Cookie', cookie ?? ''),
  logout: (cookie?: string) => request(app).post(`${BASE}/logout`).set('Cookie', cookie ?? ''),
});

export async function registerUser(app: Target, email = 'new.user@example.test') {
  const res = await api(app).register({ email, password: PASSWORD });
  return { email, challengeId: res.body.challengeId as string, expiresAt: res.body.expiresAt as string };
}

/** The `sid` value from a Set-Cookie header. */
export function sessionToken(res: request.Response): string {
  const header = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('sid='));
  if (!header) throw new Error('no sid cookie');
  return decodeURIComponent(header.split(';')[0]!.slice('sid='.length));
}

export function setCookieHeader(res: request.Response): string {
  return (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('sid=')) ?? '';
}

/** Registers, verifies and returns the `sid=...` cookie header value of the new session. */
export async function signIn(app: Target, email = 'new.user@example.test') {
  const { challengeId } = await registerUser(app, email);
  const res = await api(app).verify({ challengeId, code: OTP });
  return { email, userId: res.body.user.id as string, cookie: `sid=${sessionToken(res)}` };
}
