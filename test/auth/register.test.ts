import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { otpChallenges, users } from '../../src/db/schema/index.js';
import { OTP_TTL_MS } from '../../src/modules/auth/service.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';
import { api, createAuthApp, createClock, OTP, PASSWORD, registerUser } from './helpers.js';

describe('POST /auth/register', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });

  beforeEach(resetDb);

  it('creates an unverified user and a REGISTER challenge valid for 5 minutes', async () => {
    const res = await api(app).register({ email: 'a@example.test', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.challengeId).toEqual(expect.any(String));
    expect(res.body.expiresAt).toBe(new Date(clock.now().getTime() + OTP_TTL_MS).toISOString());

    const [user] = await testDb.select().from(users);
    expect(user).toMatchObject({ email: 'a@example.test', role: 'USER', emailVerifiedAt: null });
    const [challenge] = await testDb.select().from(otpChallenges);
    expect(challenge).toMatchObject({
      id: res.body.challengeId,
      userId: user!.id,
      purpose: 'REGISTER',
      attempts: 0,
      consumedAt: null,
    });
  });

  it('never stores the password or the OTP in clear text', async () => {
    await api(app).register({ email: 'a@example.test', password: PASSWORD });

    const [user] = await testDb.select().from(users);
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(user!.passwordHash).not.toContain(PASSWORD);
    const [challenge] = await testDb.select().from(otpChallenges);
    expect(challenge!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge!.codeHash).not.toContain(OTP);
  });

  it('does not leak the hash or any user data in the response', async () => {
    const res = await api(app).register({ email: 'a@example.test', password: PASSWORD });
    expect(Object.keys(res.body).sort()).toEqual(['challengeId', 'expiresAt']);
  });

  it('normalizes the email (trim + lowercase)', async () => {
    const res = await api(app).register({ email: '  Mixed.Case@Example.TEST ', password: PASSWORD });
    expect(res.status).toBe(201);
    const [user] = await testDb.select().from(users);
    expect(user!.email).toBe('mixed.case@example.test');
  });

  it.each([
    ['missing email', { password: PASSWORD }, 'body.email'],
    ['not an email', { email: 'nope', password: PASSWORD }, 'body.email'],
    ['email over 254 chars', { email: `${'a'.repeat(250)}@example.test`, password: PASSWORD }, 'body.email'],
    ['password under 8 chars', { email: 'a@example.test', password: 'short' }, 'body.password'],
    ['password over 72 bytes', { email: 'a@example.test', password: 'x'.repeat(73) }, 'body.password'],
    ['multi-byte password over 72 bytes', { email: 'a@example.test', password: 'ก'.repeat(25) }, 'body.password'],
    ['password not a string', { email: 'a@example.test', password: 12345678 }, 'body.password'],
    ['unknown key', { email: 'a@example.test', password: PASSWORD, role: 'ADMIN' }, 'body'],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, body, path) => {
    const res = await api(app).register(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(await testDb.select().from(users)).toHaveLength(0);
  });

  it('accepts a password of exactly 72 bytes and exactly 8 characters', async () => {
    expect((await api(app).register({ email: 'a@example.test', password: 'x'.repeat(72) })).status).toBe(201);
    expect((await api(app).register({ email: 'b@example.test', password: 'x'.repeat(8) })).status).toBe(201);
  });

  it('answers 409 EMAIL_TAKEN for a verified account, ignoring case, and leaves it untouched', async () => {
    const existing = await createUser({ email: 'taken@example.test', passwordHash: 'original-hash' });

    const res = await api(app).register({ email: 'TAKEN@example.test', password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    const [row] = await testDb.select().from(users).where(eq(users.id, existing.id));
    expect(row!.passwordHash).toBe('original-hash');
    expect(await testDb.select().from(otpChallenges)).toHaveLength(0);
  });

  it('replaces the password of an unverified account and invalidates its earlier challenge', async () => {
    const first = await registerUser(app, 'again@example.test');
    const [before] = await testDb.select().from(users);

    const res = await api(app).register({ email: 'again@example.test', password: 'a different password' });

    expect(res.status).toBe(201);
    expect(res.body.challengeId).not.toBe(first.challengeId);
    const rows = await testDb.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.passwordHash).not.toBe(before!.passwordHash);

    const old = await api(app).verify({ challengeId: first.challengeId, code: OTP });
    expect(old.status).toBe(400);
    expect(old.body.error.code).toBe('OTP_INVALID');
    const fresh = await api(app).verify({ challengeId: res.body.challengeId, code: OTP });
    expect(fresh.status).toBe(200);
  });

  it('survives two simultaneous registrations of the same new email', async () => {
    const results = await Promise.all([
      api(app).register({ email: 'race@example.test', password: PASSWORD }),
      api(app).register({ email: 'race@example.test', password: PASSWORD }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await testDb.select().from(users)).toHaveLength(1);
  });
});

describe('POST /auth/register rate limit', () => {
  const previous = config.rateLimitEnabled;
  beforeEach(async () => {
    await resetDb();
    config.rateLimitEnabled = true;
  });
  afterEach(() => {
    config.rateLimitEnabled = previous;
  });

  it('allows 3 registrations per hour per IP, then 429 RATE_LIMITED', async () => {
    const app = createAuthApp({ now: createClock().now });
    for (const n of [1, 2, 3]) {
      expect((await api(app).register({ email: `u${n}@example.test`, password: PASSWORD })).status).toBe(201);
    }
    const blocked = await api(app).register({ email: 'u4@example.test', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
