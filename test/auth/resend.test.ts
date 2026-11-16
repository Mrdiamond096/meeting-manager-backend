import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import type { OtpProvider } from '../../src/modules/auth/otp-provider.js';
import { MockOtpProvider } from '../../src/modules/auth/otp-provider.js';
import { OTP_TTL_MS, RESEND_WINDOW_MS } from '../../src/modules/auth/service.js';
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

    const rows = await testDb.otpChallenge.findMany();
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
    expect(await testDb.otpChallenge.findMany()).toHaveLength(1);
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

/** Every resend returns a new challenge id, so the budget has to follow the account, not the id. */
describe('resend budget', () => {
  beforeEach(resetDb);

  /** Resends repeatedly, always using the id returned by the previous resend (what a client or attacker does). */
  async function chainResends(app: ReturnType<typeof createAuthApp>, challengeId: string, times: number) {
    const statuses: number[] = [];
    let current = challengeId;
    for (let i = 0; i < times; i += 1) {
      const res = await api(app).resend({ challengeId: current });
      statuses.push(res.status);
      if (res.status === 200) current = res.body.challengeId;
    }
    return { statuses, last: current };
  }

  it('allows 3 resends per account, then 429, even when chaining the newly issued ids', async () => {
    const app = createAuthApp({ now: createClock().now });
    const { challengeId } = await registerUser(app);

    const { statuses } = await chainResends(app, challengeId, 8);

    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    expect(await testDb.otpChallenge.findMany()).toHaveLength(4);
  });

  it('answers RATE_LIMITED and leaves the latest challenge usable', async () => {
    const app = createAuthApp({ now: createClock().now });
    const { challengeId } = await registerUser(app);
    const { last } = await chainResends(app, challengeId, 3);

    const blocked = await api(app).resend({ challengeId: last });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // The refused resend rolled back: the challenge it tried to replace still works.
    expect((await api(app).verify({ challengeId: last, code: OTP })).status).toBe(200);
  });

  it('is counted in the database, so it holds without the in-memory limiter', async () => {
    expect(config.rateLimitEnabled).toBe(false);
    const app = createAuthApp({ now: createClock().now });
    const { challengeId } = await registerUser(app);

    const { statuses } = await chainResends(app, challengeId, 4);

    expect(statuses.at(-1)).toBe(429);
  });

  it('frees the budget once the 15 minute window has passed', async () => {
    const clock = createClock();
    const app = createAuthApp({ now: clock.now });
    const { challengeId } = await registerUser(app);
    const { last } = await chainResends(app, challengeId, 3);

    clock.advance(RESEND_WINDOW_MS - 1);
    expect((await api(app).resend({ challengeId: last })).status).toBe(429);

    clock.advance(1);
    expect((await api(app).resend({ challengeId: last })).status).toBe(200);
  });

  it('keeps one account from spending another account\'s budget', async () => {
    const app = createAuthApp({ now: createClock().now });
    const a = await registerUser(app, 'a@example.test');
    const b = await registerUser(app, 'b@example.test');
    await chainResends(app, a.challengeId, 4);

    expect((await api(app).resend({ challengeId: b.challengeId })).status).toBe(200);
  });

  it('never lets simultaneous resends of one account exceed the budget', async () => {
    const app = createAuthApp({ now: createClock().now });
    const { challengeId } = await registerUser(app);

    const results = await Promise.all(Array.from({ length: 10 }, () => api(app).resend({ challengeId })));

    // All ten use the same id, so at most one can win, and nothing may fail with a 5xx.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
  });
});

describe('POST /auth/otp/resend IP backstop', () => {
  const previous = config.rateLimitEnabled;
  beforeEach(async () => {
    await resetDb();
    config.rateLimitEnabled = true;
  });
  afterEach(() => {
    config.rateLimitEnabled = previous;
  });

  it('allows 10 requests per IP per 15 minutes whatever challenge ids they carry, then 429', async () => {
    const app = createAuthApp({ now: createClock().now });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await api(app).resend({ challengeId: randomUUID() })).status);

    expect(statuses).toEqual([...Array(10).fill(400), 429]);
  });
});
