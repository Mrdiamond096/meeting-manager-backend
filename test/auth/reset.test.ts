import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import type { OtpProvider } from '../../src/modules/auth/otp-provider.js';
import { createPasswordHasher, type PasswordHasher } from '../../src/modules/auth/password.js';
import { MAX_RESETS_PER_WINDOW, OTP_TTL_MS, RESET_WINDOW_MS } from '../../src/modules/auth/service.js';
import { resetDb, testDb } from '../helpers/db.js';
import {
  api,
  createAuthApp,
  createClock,
  createLogCapture,
  OTP,
  PASSWORD,
  registerUser,
  signIn,
} from './helpers.js';

const NEW_PASSWORD = 'a brand new passphrase';
const email = 'forgetful@example.test';

describe('POST /auth/password/forgot', () => {
  const clock = createClock();
  const deliver = vi.fn<OtpProvider['deliver']>(async () => {});
  const provider: OtpProvider = { generateCode: () => OTP, deliver };
  const app = createAuthApp({ now: clock.now, otpProvider: provider });

  beforeEach(async () => {
    await resetDb();
    deliver.mockClear();
    await signIn(app, email);
    deliver.mockClear();
  });

  it('answers 202 and issues a RESET challenge valid for 5 minutes for a known email', async () => {
    const res = await api(app).forgot({ email });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      challengeId: expect.any(String),
      expiresAt: new Date(clock.now().getTime() + OTP_TTL_MS).toISOString(),
    });
    const rows = await testDb.otpChallenge.findMany({ where: { purpose: 'RESET' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.body.challengeId, consumedAt: null, attempts: 0 });
    expect(deliver).toHaveBeenCalledWith({ userId: rows[0]!.userId, purpose: 'RESET' }, OTP);
  });

  it('answers the same way for an unknown email, without storing or sending anything', async () => {
    const known = await api(app).forgot({ email });
    const unknown = await api(app).forgot({ email: 'nobody@example.test' });

    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort());
    expect(unknown.body.expiresAt).toBe(known.body.expiresAt);
    expect(unknown.body.challengeId).not.toBe(known.body.challengeId);
    expect(await testDb.otpChallenge.count({ where: { purpose: 'RESET' } })).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('normalizes the email like every other auth endpoint', async () => {
    const res = await api(app).forgot({ email: `  ${email.toUpperCase()} ` });
    expect(res.status).toBe(202);
    expect(await testDb.otpChallenge.count({ where: { purpose: 'RESET' } })).toBe(1);
  });

  it.each([
    ['missing email', {}],
    ['not an email', { email: 'nope' }],
    ['unknown key', { email, extra: 1 }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, body) => {
    const res = await api(app).forgot(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('retires the previous reset challenge when a new one is requested', async () => {
    const first = await api(app).forgot({ email });
    const second = await api(app).forgot({ email });

    const old = await api(app).reset({ challengeId: first.body.challengeId, code: OTP, newPassword: NEW_PASSWORD });
    expect(old.status).toBe(400);
    const fresh = await api(app).reset({ challengeId: second.body.challengeId, code: OTP, newPassword: NEW_PASSWORD });
    expect(fresh.status).toBe(204);
  });

  it('stops issuing codes after the hourly budget, still answering 202 like any other request', async () => {
    for (let i = 0; i < MAX_RESETS_PER_WINDOW; i += 1) {
      expect((await api(app).forgot({ email })).status).toBe(202);
    }
    expect(deliver).toHaveBeenCalledTimes(MAX_RESETS_PER_WINDOW);

    const over = await api(app).forgot({ email });
    expect(over.status).toBe(202);
    expect(over.body.challengeId).toEqual(expect.any(String));
    expect(deliver).toHaveBeenCalledTimes(MAX_RESETS_PER_WINDOW);
    expect(await testDb.otpChallenge.count({ where: { purpose: 'RESET' } })).toBe(MAX_RESETS_PER_WINDOW);
    expect((await api(app).reset({ challengeId: over.body.challengeId, code: OTP, newPassword: NEW_PASSWORD })).status).toBe(400);

    clock.advance(RESET_WINDOW_MS + 1);
    expect((await api(app).forgot({ email })).status).toBe(202);
    expect(deliver).toHaveBeenCalledTimes(MAX_RESETS_PER_WINDOW + 1);
  });
});

describe('POST /auth/password/reset', () => {
  const clock = createClock();
  const logs = createLogCapture();
  const app = createAuthApp({ now: clock.now, logger: logs.logger });

  beforeEach(resetDb);

  async function startReset(who = email) {
    const res = await api(app).forgot({ email: who });
    return res.body.challengeId as string;
  }

  it('replaces the password: the new one logs in, the old one does not', async () => {
    await signIn(app, email);
    const challengeId = await startReset();

    const res = await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await api(app).login({ email, password: PASSWORD })).status).toBe(401);
    expect((await api(app).login({ email, password: NEW_PASSWORD })).status).toBe(200);
    const user = await testDb.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$04\$/); // bcrypt, never the plain text
    expect(user.passwordHash).not.toContain(NEW_PASSWORD);
  });

  it('signs the user out everywhere, leaving other users alone', async () => {
    const first = await signIn(app, email);
    const loginRes = await api(app).login({ email, password: PASSWORD });
    const second = await api(app).verify({ challengeId: loginRes.body.challengeId, code: OTP });
    const secondCookie = `sid=${decodeURIComponent((second.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!.slice(4))}`;
    const other = await signIn(app, 'bystander@example.test');
    expect(await testDb.session.count({ where: { userId: first.userId } })).toBe(2);

    const challengeId = await startReset();
    await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD });

    expect((await api(app).me(first.cookie)).status).toBe(401);
    expect((await api(app).me(secondCookie)).status).toBe(401);
    expect(await testDb.session.count({ where: { userId: first.userId } })).toBe(0);
    expect((await api(app).me(other.cookie)).status).toBe(200);
  });

  it('does not sign anyone in: a session only comes from login', async () => {
    await signIn(app, email);
    const res = await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: NEW_PASSWORD });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('invalidates other open challenges of the account (a login started with the old password)', async () => {
    await signIn(app, email);
    const pendingLogin = await api(app).login({ email, password: PASSWORD });

    await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: NEW_PASSWORD });

    const res = await api(app).verify({ challengeId: pendingLogin.body.challengeId, code: OTP });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('proves the email of an account that never verified it', async () => {
    await registerUser(app, email);
    expect((await testDb.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toBeNull();

    await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: NEW_PASSWORD });

    expect((await testDb.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();
  });

  it('is single use', async () => {
    await signIn(app, email);
    const challengeId = await startReset();
    expect((await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD })).status).toBe(204);

    const again = await api(app).reset({ challengeId, code: OTP, newPassword: 'another passphrase 2' });
    expect(again.status).toBe(400);
    expect((await api(app).login({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('refuses an expired challenge', async () => {
    await signIn(app, email);
    const challengeId = await startReset();
    clock.advance(OTP_TTL_MS + 1);

    const res = await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect((await api(app).login({ email, password: PASSWORD })).status).toBe(200);
  });

  describe('wrong codes', () => {
    it('answers OTP_INVALID with no attempt counter, so a real challenge looks like the fake one', async () => {
      await signIn(app, email);
      const real = await api(app).reset({ challengeId: await startReset(), code: '000000', newPassword: NEW_PASSWORD });
      const fakeId = (await api(app).forgot({ email: 'nobody@example.test' })).body.challengeId;
      const fake = await api(app).reset({ challengeId: fakeId, code: '000000', newPassword: NEW_PASSWORD });

      expect(real.status).toBe(400);
      expect(real.body.error.code).toBe('OTP_INVALID');
      expect(real.body.error.details).toBeUndefined();
      expect({ ...real.body.error, requestId: undefined }).toEqual({ ...fake.body.error, requestId: undefined });
    });

    it('locks the challenge after 5 wrong codes, even for the right one, and logs a warning', async () => {
      await signIn(app, email);
      const challengeId = await startReset();
      for (let i = 0; i < 5; i += 1) {
        expect((await api(app).reset({ challengeId, code: '000000', newPassword: NEW_PASSWORD })).status).toBe(400);
      }

      expect((await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD })).status).toBe(400);
      expect((await testDb.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts).toBe(5);
      expect((await api(app).login({ email, password: PASSWORD })).status).toBe(200);
      const warns = logs.records().filter((r) => r.msg === 'otp challenge locked after too many wrong codes');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ level: 40, purpose: 'RESET' });
    });
  });

  describe('which challenges can reset', () => {
    it('refuses a REGISTER challenge', async () => {
      const { challengeId } = await registerUser(app, email);
      const res = await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
    });

    it('refuses a LOGIN challenge', async () => {
      await signIn(app, email);
      const login = await api(app).login({ email, password: PASSWORD });
      const res = await api(app).reset({ challengeId: login.body.challengeId, code: OTP, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect((await api(app).login({ email, password: PASSWORD })).status).toBe(200);
    });

    it('refuses a made-up id', async () => {
      const res = await api(app).reset({ challengeId: '7d0c4bb1-1b0b-4cd3-8e1e-2f2b6ad5d3a1', code: OTP, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID');
    });

    it('cannot be resent, which would otherwise tell a real reset challenge from a fake one', async () => {
      await signIn(app, email);
      const real = await api(app).resend({ challengeId: await startReset() });
      const fakeId = (await api(app).forgot({ email: 'nobody@example.test' })).body.challengeId;
      const fake = await api(app).resend({ challengeId: fakeId });

      expect(real.status).toBe(400);
      expect(real.body.error.code).toBe('OTP_INVALID');
      expect(fake.status).toBe(real.status);
      expect(fake.body.error.code).toBe(real.body.error.code);
      expect(fake.body.error.details).toEqual(real.body.error.details);
    });
  });

  describe('validation', () => {
    it.each([
      ['password under 8 characters', { newPassword: 'short' }],
      ['password over 72 bytes', { newPassword: 'x'.repeat(73) }],
      ['multi-byte password over 72 bytes', { newPassword: 'ก'.repeat(25) }],
      ['code that is not 6 digits', { code: '12345' }],
      ['unknown key', { extra: 1 }],
      ['non-uuid challenge id', { challengeId: 'nope' }],
    ])('rejects %s with 400 VALIDATION_ERROR and leaves the challenge untouched', async (_name, override) => {
      await signIn(app, email);
      const challengeId = await startReset();

      const res = await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD, ...override });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const row = await testDb.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      expect(row).toMatchObject({ consumedAt: null, attempts: 0 });
    });

    it('accepts a password of exactly 8 characters and one of exactly 72 bytes', async () => {
      await signIn(app, email);
      expect((await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: '12345678' })).status).toBe(204);
      expect((await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: 'x'.repeat(72) })).status).toBe(204);
    });
  });

  it('never writes the new password or the code to the logs', async () => {
    await signIn(app, email);
    await api(app).reset({ challengeId: await startReset(), code: OTP, newPassword: NEW_PASSWORD });
    await api(app).reset({ challengeId: await startReset(), code: '000000', newPassword: NEW_PASSWORD });

    expect(logs.text()).not.toContain(NEW_PASSWORD);
    expect(logs.text()).not.toContain('"code":"112233"');
  });
});

describe('login racing a password reset', () => {
  const clock = createClock();

  beforeEach(resetDb);

  it('does not let a password checked before the reset open a login afterwards', async () => {
    // The hasher stands in for the slow bcrypt compare: the old password is accepted, and the reset
    // completes before login reaches its transaction.
    const real = createPasswordHasher(4);
    let resetOnce: (() => Promise<void>) | undefined;
    const hasher: PasswordHasher = {
      ...real,
      verify: async (plain, hashed) => {
        const ok = await real.verify(plain, hashed);
        const run = resetOnce;
        resetOnce = undefined;
        await run?.();
        return ok;
      },
    };
    const app = createAuthApp({ now: clock.now, passwordHasher: hasher });
    await signIn(app, email);
    const { challengeId } = (await api(app).forgot({ email })).body;
    resetOnce = async () => {
      const done = await api(app).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD });
      expect(done.status).toBe(204);
    };

    const res = await api(app).login({ email, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await testDb.otpChallenge.findMany({ where: { purpose: 'LOGIN' } })).toEqual([]);
    expect(await testDb.session.count()).toBe(0);
    // And the new password still works afterwards.
    expect((await api(app).login({ email, password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe('password reset under concurrency', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });
  const server = app;

  beforeEach(resetDb);

  it('lets exactly one of several simultaneous resets with the same challenge win', async () => {
    await signIn(server, email);
    const { challengeId } = (await api(server).forgot({ email })).body;

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api(server).reset({ challengeId, code: OTP, newPassword: `${NEW_PASSWORD} ${i}` }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual([204, 400, 400, 400, 400, 400]);
    expect(await testDb.session.count()).toBe(0);
  });

  it('never answers 500 when forgot, reset and login race on one account', async () => {
    await signIn(server, email);
    const { challengeId } = (await api(server).forgot({ email })).body;

    const results = await Promise.all([
      api(server).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD }),
      api(server).forgot({ email }),
      api(server).login({ email, password: PASSWORD }),
      api(server).forgot({ email }),
      api(server).login({ email, password: PASSWORD }),
      api(server).reset({ challengeId, code: OTP, newPassword: NEW_PASSWORD }),
    ]);

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
  });
});

describe('POST /auth/password/forgot rate limit', () => {
  beforeEach(resetDb);

  it('allows 3 per IP + email per hour, then 429 for that email only', async () => {
    const app = createAuthApp({ now: createClock().now, rateLimitConfig: { ...config, rateLimitEnabled: true } });
    await signIn(app, email);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await api(app).forgot({ email })).status);
    expect(statuses).toEqual([202, 202, 202]);

    const blocked = await api(app).forgot({ email });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await api(app).forgot({ email: 'someone.else@example.test' })).status).toBe(202);
  });

  it('applies to unknown emails too, so the limit itself reveals nothing', async () => {
    const app = createAuthApp({ now: createClock().now, rateLimitConfig: { ...config, rateLimitEnabled: true } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await api(app).forgot({ email: 'ghost@example.test' })).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});
