import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashOtpCode } from '../../src/modules/auth/otp-code.js';
import { hashSessionToken } from '../../src/modules/auth/session.js';
import { OTP_TTL_MS } from '../../src/modules/auth/service.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';
import {
  api,
  createAuthApp,
  createClock,
  createLogCapture,
  OTP,
  PASSWORD,
  registerUser,
  sessionToken,
  setCookieHeader,
} from './helpers.js';

const WRONG = '000000';

function attemptsRemaining(body: {
  error: { details: { path: string; message: string }[] };
}): number {
  const detail = body.error.details.find((d) => d.path === 'attemptsRemaining');
  return Number(detail?.message);
}

describe('POST /auth/otp/verify', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });

  beforeEach(resetDb);

  it('verifies the email, signs in and returns the public user', async () => {
    const { email, challengeId } = await registerUser(app);

    const res = await api(app).verify({ challengeId, code: OTP });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: expect.any(String), email, role: 'RECRUITER' } });
    const [user] = await testDb.user.findMany();
    expect(user!.emailVerifiedAt).toEqual(clock.now());
    const [challenge] = await testDb.otpChallenge.findMany();
    expect(challenge!.consumedAt).toEqual(clock.now());
  });

  it('sets an httpOnly, SameSite=Lax, Path=/ sid cookie that lives 7 days and is not Secure by default', async () => {
    const { challengeId } = await registerUser(app);

    const res = await api(app).verify({ challengeId, code: OTP });

    const cookie = setCookieHeader(res);
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure to the cookie when configured', async () => {
    const secureApp = createAuthApp({ now: clock.now, cookieSecure: true });
    const { challengeId } = await registerUser(secureApp);

    const res = await api(secureApp).verify({ challengeId, code: OTP });

    expect(setCookieHeader(res)).toContain('Secure');
  });

  it('stores only the SHA-256 of the token, with a 7 day absolute expiry', async () => {
    const { challengeId } = await registerUser(app);

    const res = await api(app).verify({ challengeId, code: OTP });

    const token = sessionToken(res);
    const rows = await testDb.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashSessionToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.userId).toBe(res.body.user.id);
    expect(rows[0]!.expiresAt).toEqual(new Date(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000));
  });

  it('issues a different token on every sign-in', async () => {
    const first = await registerUser(app, 'a@example.test');
    const second = await registerUser(app, 'b@example.test');
    const a = await api(app).verify({ challengeId: first.challengeId, code: OTP });
    const b = await api(app).verify({ challengeId: second.challengeId, code: OTP });
    expect(sessionToken(a)).not.toBe(sessionToken(b));
  });

  it('counts down attemptsRemaining on wrong codes and locks after 5', async () => {
    const { challengeId } = await registerUser(app);

    const remaining: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await api(app).verify({ challengeId, code: WRONG });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
      remaining.push(attemptsRemaining(res.body));
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    // The right code no longer works once the challenge is locked.
    const locked = await api(app).verify({ challengeId, code: OTP });
    expect(locked.status).toBe(400);
    expect(locked.body.error.code).toBe('OTP_INVALID');
    expect(attemptsRemaining(locked.body)).toBe(0);
    expect(await testDb.session.findMany()).toHaveLength(0);
  });

  it('never pushes attempts past 5 (CHECK constraint) even with extra wrong codes', async () => {
    const { challengeId } = await registerUser(app);
    for (let i = 0; i < 8; i += 1) {
      expect((await api(app).verify({ challengeId, code: WRONG })).status).toBe(400);
    }
    const [challenge] = await testDb.otpChallenge.findMany();
    expect(challenge!.attempts).toBe(5);
  });

  it('accepts the right code after fewer than 5 wrong ones', async () => {
    const { challengeId } = await registerUser(app);
    for (let i = 0; i < 4; i += 1) await api(app).verify({ challengeId, code: WRONG });

    expect((await api(app).verify({ challengeId, code: OTP })).status).toBe(200);
  });

  it('logs a warn with ids only when a challenge gets locked', async () => {
    const capture = createLogCapture();
    const logged = createAuthApp({ now: clock.now, logger: capture.logger });
    const { challengeId } = await registerUser(logged, 'locked@example.test');

    for (let i = 0; i < 5; i += 1) await api(logged).verify({ challengeId, code: WRONG });

    const warns = capture.records().filter((r) => r.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      challengeId,
      purpose: 'REGISTER',
      msg: expect.stringContaining('locked'),
    });
    expect(warns[0]!.userId).toEqual(expect.any(String));
  });

  it('rejects a challenge that was already used', async () => {
    const { challengeId } = await registerUser(app);
    expect((await api(app).verify({ challengeId, code: OTP })).status).toBe(200);

    const again = await api(app).verify({ challengeId, code: OTP });

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('OTP_INVALID');
    expect(await testDb.session.findMany()).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous correct submissions through', async () => {
    const { challengeId } = await registerUser(app);

    const results = await Promise.all([
      api(app).verify({ challengeId, code: OTP }),
      api(app).verify({ challengeId, code: OTP }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await testDb.session.findMany()).toHaveLength(1);
  });

  it('rejects an expired challenge without counting an attempt, even with the right code', async () => {
    const timed = createClock();
    const timedApp = createAuthApp({ now: timed.now });
    const { challengeId } = await registerUser(timedApp);
    timed.advance(OTP_TTL_MS);

    const res = await api(timedApp).verify({ challengeId, code: OTP });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    const [challenge] = await testDb.otpChallenge.findMany();
    expect(challenge!.attempts).toBe(0);
    expect(await testDb.session.findMany()).toHaveLength(0);
  });

  it('still accepts the code one millisecond before expiry', async () => {
    const timed = createClock();
    const timedApp = createAuthApp({ now: timed.now });
    const { challengeId } = await registerUser(timedApp);
    timed.advance(OTP_TTL_MS - 1);

    const res = await api(timedApp).verify({ challengeId, code: OTP });

    expect(res.status).toBe(200);
  });

  it('answers OTP_INVALID for an unknown challenge id', async () => {
    const res = await api(app).verify({ challengeId: randomUUID(), code: OTP });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(attemptsRemaining(res.body)).toBe(0);
  });

  it('refuses a RESET challenge on the sign-in endpoint', async () => {
    const user = await createUser();
    const id = randomUUID();
    await testDb.otpChallenge.create({
      data: {
        id,
        userId: user.id,
        purpose: 'RESET',
        codeHash: hashOtpCode(id, OTP),
        expiresAt: new Date(clock.now().getTime() + OTP_TTL_MS),
      },
    });

    const res = await api(app).verify({ challengeId: id, code: OTP });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(await testDb.session.findMany()).toHaveLength(0);
  });

  it('also accepts a LOGIN challenge and marks an unverified account verified', async () => {
    const user = await createUser({ emailVerifiedAt: null });
    const id = randomUUID();
    await testDb.otpChallenge.create({
      data: {
        id,
        userId: user.id,
        purpose: 'LOGIN',
        codeHash: hashOtpCode(id, OTP),
        expiresAt: new Date(clock.now().getTime() + OTP_TTL_MS),
      },
    });

    const res = await api(app).verify({ challengeId: id, code: OTP });

    expect(res.status).toBe(200);
    const [row] = await testDb.user.findMany({ where: { id: user.id } });
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it.each([
    ['non-uuid challengeId', { challengeId: 'abc', code: OTP }],
    ['short code', { challengeId: randomUUID(), code: '123' }],
    ['non-numeric code', { challengeId: randomUUID(), code: 'abcdef' }],
    ['numeric (non-string) code', { challengeId: randomUUID(), code: 112233 }],
    ['missing code', { challengeId: randomUUID() }],
    ['unknown key', { challengeId: randomUUID(), code: OTP, extra: true }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, body) => {
    const res = await api(app).verify(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps passwords, OTP codes, tokens and emails out of the logs', async () => {
    const capture = createLogCapture();
    const logged = createAuthApp({ now: clock.now, logger: capture.logger });
    const email = 'secret.person@example.test';

    const { challengeId } = await registerUser(logged, email);
    await api(logged).verify({ challengeId, code: WRONG });
    const ok = await api(logged).verify({ challengeId, code: OTP });
    await api(logged)
      .register({ email, password: PASSWORD })
      .set('Cookie', `sid=${sessionToken(ok)}`);

    const output = capture.text();
    expect(output.length).toBeGreaterThan(0);
    for (const secret of [PASSWORD, OTP, WRONG, sessionToken(ok), email]) {
      expect(output).not.toContain(secret);
    }
  });
});
