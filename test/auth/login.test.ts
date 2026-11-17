import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import { OTP_TTL_MS } from '../../src/modules/auth/service.js';
import { resetDb, testDb } from '../helpers/db.js';
import { api, createAuthApp, createClock, OTP, PASSWORD, registerUser, setCookieHeader, signIn } from './helpers.js';

describe('POST /auth/login', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });
  const email = 'member@example.test';

  beforeEach(async () => {
    await resetDb();
    await signIn(app, email);
    await testDb.session.deleteMany();
    await testDb.otpChallenge.deleteMany();
  });

  it('checks the password and issues a LOGIN challenge, but no session yet (2FA)', async () => {
    const res = await api(app).login({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['challengeId', 'expiresAt']);
    expect(res.body.expiresAt).toBe(new Date(clock.now().getTime() + OTP_TTL_MS).toISOString());
    expect(setCookieHeader(res)).toBe('');
    expect(await testDb.session.findMany()).toHaveLength(0);
    const [challenge] = await testDb.otpChallenge.findMany();
    expect(challenge).toMatchObject({ id: res.body.challengeId, purpose: 'LOGIN', attempts: 0, consumedAt: null });
  });

  it('signs in only after the OTP is verified, and the session works', async () => {
    const login = await api(app).login({ email, password: PASSWORD });
    const verified = await api(app).verify({ challengeId: login.body.challengeId, code: OTP });

    expect(verified.status).toBe(200);
    expect(verified.body.user.email).toBe(email);
    const cookie = setCookieHeader(verified).split(';')[0]!;
    expect((await api(app).me(cookie)).status).toBe(200);
  });

  it('requires an OTP on every login, not just the first', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await api(app).login({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(setCookieHeader(res)).toBe('');
    }
  });

  it('accepts the email in any case and with surrounding spaces', async () => {
    const res = await api(app).login({ email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('gives a wrong password and an unknown email the same 401 response', async () => {
    const wrongPassword = await api(app).login({ email, password: 'not the password' });
    const unknownEmail = await api(app).login({ email: 'nobody@example.test', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.details).toBeUndefined();
    }
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    expect(await testDb.otpChallenge.findMany()).toHaveLength(0);
  });

  describe('bcrypt 72-byte limit', () => {
    // bcrypt only reads 72 bytes, so without a check the 73rd byte and beyond would be ignored.
    it.each([
      ['ASCII', 'x'.repeat(72), 'x'.repeat(72) + 'y'],
      ['multi-byte', 'ก'.repeat(24), 'ก'.repeat(24) + 'a'],
    ])('answers 401 for a %s password that only matches its first 72 bytes', async (_name, exact, longer) => {
      const who = 'limit@example.test';
      const { challengeId } = (await api(app).register({ email: who, password: exact })).body;
      await api(app).verify({ challengeId, code: OTP });
      await testDb.otpChallenge.deleteMany();

      const ok = await api(app).login({ email: who, password: exact });
      expect(ok.status).toBe(200);
      await testDb.otpChallenge.deleteMany();

      const res = await api(app).login({ email: who, password: longer });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(await testDb.otpChallenge.findMany()).toHaveLength(0);
    });

    it('still spends one bcrypt comparison on an over-long password', async () => {
      const real = createPasswordHasher(4);
      const verify = vi.spyOn(real, 'verify');
      const verifyAgainstDummy = vi.spyOn(real, 'verifyAgainstDummy');
      const spied = createAuthApp({ now: clock.now, passwordHasher: real });

      await api(spied).login({ email, password: PASSWORD.padEnd(73, 'x') });

      expect(verify).not.toHaveBeenCalled();
      expect(verifyAgainstDummy).toHaveBeenCalledTimes(1);
    });
  });

  it('still spends a bcrypt comparison when the email is unknown (no timing oracle)', async () => {
    const real = createPasswordHasher(4);
    const verify = vi.spyOn(real, 'verify');
    const verifyAgainstDummy = vi.spyOn(real, 'verifyAgainstDummy');
    const spied = createAuthApp({ now: clock.now, passwordHasher: real });

    await api(spied).login({ email: 'nobody@example.test', password: PASSWORD });
    expect(verifyAgainstDummy).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();

    await api(spied).login({ email, password: PASSWORD });
    expect(verifyAgainstDummy).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('retires the previous LOGIN challenge when a new login starts', async () => {
    const first = await api(app).login({ email, password: PASSWORD });
    const second = await api(app).login({ email, password: PASSWORD });

    const old = await api(app).verify({ challengeId: first.body.challengeId, code: OTP });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe('OTP_INVALID');
    expect((await api(app).verify({ challengeId: second.body.challengeId, code: OTP })).status).toBe(200);
  });

  it('lets an unverified account log in; the OTP then proves the email', async () => {
    const pending = await registerUser(app, 'pending@example.test');
    expect(pending.challengeId).toBeDefined();

    const login = await api(app).login({ email: 'pending@example.test', password: PASSWORD });
    expect(login.status).toBe(200);
    const verified = await api(app).verify({ challengeId: login.body.challengeId, code: OTP });

    expect(verified.status).toBe(200);
    const rows = await testDb.user.findMany();
    expect(rows.find((u) => u.email === 'pending@example.test')!.emailVerifiedAt).not.toBeNull();
  });

  it.each([
    ['missing password', { email }],
    ['empty password', { email, password: '' }],
    ['invalid email', { email: 'nope', password: PASSWORD }],
    ['password not a string', { email, password: 12345678 }],
    ['unknown key', { email, password: PASSWORD, remember: true }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, body) => {
    const res = await api(app).login(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers a very short or very long wrong password with the usual 401', async () => {
    expect((await api(app).login({ email, password: 'x' })).status).toBe(401);
    expect((await api(app).login({ email, password: 'x'.repeat(500) })).status).toBe(401);
  });
});

describe('POST /auth/login rate limit', () => {
  beforeEach(resetDb);

  it('allows 5 attempts per IP + email per 15 minutes, then 429 even with the right password', async () => {
    const app = createAuthApp({ now: createClock().now, rateLimitConfig: { ...config, rateLimitEnabled: true } });
    const email = 'limited@example.test';
    await signIn(app, email);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await api(app).login({ email, password: 'wrong password' })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);

    const blocked = await api(app).login({ email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('counts per email, so another account from the same IP is unaffected', async () => {
    const app = createAuthApp({ now: createClock().now, rateLimitConfig: { ...config, rateLimitEnabled: true } });
    await signIn(app, 'one@example.test');
    for (let i = 0; i < 5; i += 1) await api(app).login({ email: 'one@example.test', password: 'wrong password' });

    const other = await api(app).login({ email: 'two@example.test', password: 'wrong password' });
    expect(other.status).toBe(401);
  });
});
