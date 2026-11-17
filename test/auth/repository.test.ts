import type { Prisma } from '../../src/generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashOtpCode } from '../../src/modules/auth/otp-code.js';
import * as repo from '../../src/modules/auth/repository.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const LATER = new Date(NOW.getTime() + 5 * 60_000);

async function openChallenge(overrides: Partial<Prisma.OtpChallengeUncheckedCreateInput> = {}) {
  const user = await createUser();
  const id = randomUUID();
  await testDb.otpChallenge.create({
    data: {
      id,
      userId: user.id,
      purpose: 'REGISTER',
      codeHash: hashOtpCode(id, '112233'),
      expiresAt: LATER,
      createdAt: NOW,
      ...overrides,
    },
  });
  return id;
}

/** These hit the database concurrently on purpose: the guarantees must come from the SQL, not from request timing. */
describe('otp challenge repository (atomic guarantees)', () => {
  beforeEach(resetDb);

  it('consumes a challenge for exactly one of many concurrent callers', async () => {
    const id = await openChallenge();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.consumeChallenge(testDb, id, NOW)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not consume an expired, used or locked challenge', async () => {
    const expired = await openChallenge({ expiresAt: NOW });
    const used = await openChallenge({ consumedAt: NOW });
    const locked = await openChallenge({ attempts: repo.MAX_OTP_ATTEMPTS });

    expect(await repo.consumeChallenge(testDb, expired, NOW)).toBeUndefined();
    expect(await repo.consumeChallenge(testDb, used, NOW)).toBeUndefined();
    expect(await repo.consumeChallenge(testDb, locked, NOW)).toBeUndefined();
  });

  it('counts at most 5 wrong attempts however many arrive at once', async () => {
    const id = await openChallenge();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.recordFailedAttempt(testDb, id, NOW)),
    );

    const counted = results.filter((n): n is number => n !== undefined).sort();
    expect(counted).toEqual([1, 2, 3, 4, 5]);
    const row = await repo.findChallenge(testDb, id);
    expect(row!.attempts).toBe(5);
  });

  it('retires a challenge for resend exactly once, and allows an expired one', async () => {
    const id = await openChallenge({ expiresAt: NOW });

    const results = await Promise.all([
      repo.retireChallengeForResend(testDb, id, LATER),
      repo.retireChallengeForResend(testDb, id, LATER),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
