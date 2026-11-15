import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { otpChallenges } from '../../src/db/schema/index.js';
import type { OtpProvider } from '../../src/modules/auth/otp-provider.js';
import { MockOtpProvider } from '../../src/modules/auth/otp-provider.js';
import { OTP_TTL_MS } from '../../src/modules/auth/service.js';
import { resetDb, testDb } from '../helpers/db.js';
import { api, createAuthApp, createClock, OTP, registerUser } from './helpers.js';

describe('POST /auth/otp/resend', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });

  beforeEach(resetDb);

  it('issues a fresh challenge and retires the old one', async () => {
    const first = await registerUser(app);
    clock.advance(60_000);

    const res = await api(app).resend({ challengeId: first.challengeId });

    expect(res.status).toBe(200);
    expect(res.body.challengeId).not.toBe(first.challengeId);
    expect(res.body.expiresAt).toBe(new Date(clock.now().getTime() + OTP_TTL_MS).toISOString());

    const old = await api(app).verify({ challengeId: first.challengeId, code: OTP });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe('OTP_INVALID');
    expect((await api(app).verify({ challengeId: res.body.challengeId, code: OTP })).status).toBe(200);
  });

  it('keeps the purpose and owner of the original challenge', async () => {
    const first = await registerUser(app);
    const res = await api(app).resend({ challengeId: first.challengeId });

    const rows = await testDb.select().from(otpChallenges);
    const created = rows.find((r) => r.id === res.body.challengeId);
    const original = rows.find((r) => r.id === first.challengeId);
    expect(created).toMatchObject({ purpose: 'REGISTER', userId: original!.userId, consumedAt: null });
  });

  it('carries wrong-code attempts over so resending cannot reset the guess budget', async () => {
    const first = await registerUser(app);
    for (let i = 0; i < 3; i += 1) await api(app).verify({ challengeId: first.challengeId, code: '000000' });

    const res = await api(app).resend({ challengeId: first.challengeId });

    const wrong = await api(app).verify({ challengeId: res.body.challengeId, code: '000000' });
    expect(wrong.body.error.details).toEqual([{ path: 'attemptsRemaining', message: '1' }]);
  });

  it('refuses to resend a locked challenge', async () => {
    const first = await registerUser(app);
    for (let i = 0; i < 5; i += 1) await api(app).verify({ challengeId: first.challengeId, code: '000000' });

    const res = await api(app).resend({ challengeId: first.challengeId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(await testDb.select().from(otpChallenges)).toHaveLength(1);
  });

  it('refuses to resend a challenge that was already used', async () => {
    const first = await registerUser(app);
    await api(app).verify({ challengeId: first.challengeId, code: OTP });

    const res = await api(app).resend({ challengeId: first.challengeId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('allows resending after the challenge expired (the usual reason to resend)', async () => {
    const first = await registerUser(app);
    clock.advance(OTP_TTL_MS + 1);

    const res = await api(app).resend({ challengeId: first.challengeId });

    expect(res.status).toBe(200);
    expect((await api(app).verify({ challengeId: res.body.challengeId, code: OTP })).status).toBe(200);
  });

  it('answers OTP_INVALID for an unknown challenge id', async () => {
    const res = await api(app).resend({ challengeId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it.each([
    ['non-uuid challengeId', { challengeId: 'abc' }],
    ['missing challengeId', {}],
    ['unknown key', { challengeId: randomUUID(), email: 'a@example.test' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, body) => {
    const res = await api(app).resend(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lets only one of two simultaneous resends succeed', async () => {
    const first = await registerUser(app);

    const results = await Promise.all([
      api(app).resend({ challengeId: first.challengeId }),
      api(app).resend({ challengeId: first.challengeId }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});

describe('OTP delivery', () => {
  beforeEach(resetDb);

  it('hands the code of every issued challenge to the provider, never to the response', async () => {
    const deliver = vi.fn<OtpProvider['deliver']>(async () => {});
    const provider: OtpProvider = { generateCode: () => '654321', deliver };
    const app = createAuthApp({ now: createClock().now, otpProvider: provider });

    const first = await registerUser(app);
    await api(app).resend({ challengeId: first.challengeId });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(1, { userId: expect.any(String), purpose: 'REGISTER' }, '654321');
    expect(deliver).toHaveBeenNthCalledWith(2, { userId: expect.any(String), purpose: 'REGISTER' }, '654321');
  });

  it('validates against the code the provider generated', async () => {
    const app = createAuthApp({ now: createClock().now, otpProvider: new MockOtpProvider('999000') });
    const { challengeId } = await registerUser(app);

    expect((await api(app).verify({ challengeId, code: OTP })).status).toBe(400);
    expect((await api(app).verify({ challengeId, code: '999000' })).status).toBe(200);
  });
});

describe('POST /auth/otp/resend rate limit', () => {
  const previous = config.rateLimitEnabled;
  beforeEach(async () => {
    await resetDb();
    config.rateLimitEnabled = true;
  });
  afterEach(() => {
    config.rateLimitEnabled = previous;
  });

  it('allows 3 resends per challenge id per 15 minutes, then 429', async () => {
    const app = createAuthApp({ now: createClock().now });
    const { challengeId } = await registerUser(app);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await api(app).resend({ challengeId })).status);

    // 1st succeeds and retires the id; 2nd and 3rd are counted but rejected; 4th is throttled.
    expect(statuses).toEqual([200, 400, 400, 429]);
  });
});
