import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { otpChallenges, users } from '../../db/schema/index.js';
import type { OtpPurpose } from './otp-provider.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Repositories run either on the pool or inside a transaction. */
export type Executor = Database | Transaction;

export type UserRow = typeof users.$inferSelect;
export type ChallengeRow = typeof otpChallenges.$inferSelect;

/** ADR-009: a challenge is unusable after this many wrong codes. */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Creates the user, or replaces the password of an existing **unverified** account.
 * Returns undefined when a verified account already owns the email (atomic, no read-then-write race).
 */
export async function upsertUnverifiedUser(
  ex: Executor,
  input: { email: string; passwordHash: string; now: Date },
): Promise<UserRow | undefined> {
  const [row] = await ex
    .insert(users)
    .values({ email: input.email, passwordHash: input.passwordHash, createdAt: input.now, updatedAt: input.now })
    .onConflictDoUpdate({
      target: users.email,
      set: { passwordHash: input.passwordHash, updatedAt: input.now },
      setWhere: isNull(users.emailVerifiedAt),
    })
    .returning();
  return row;
}

export async function findUserById(ex: Executor, id: string): Promise<UserRow | undefined> {
  const [row] = await ex.select().from(users).where(eq(users.id, id));
  return row;
}

export async function markEmailVerified(ex: Executor, userId: string, now: Date): Promise<void> {
  await ex
    .update(users)
    .set({ emailVerifiedAt: now, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
}

export async function insertChallenge(
  ex: Executor,
  input: {
    id: string;
    userId: string;
    purpose: OtpPurpose;
    codeHash: string;
    attempts: number;
    expiresAt: Date;
    now: Date;
  },
): Promise<void> {
  await ex.insert(otpChallenges).values({
    id: input.id,
    userId: input.userId,
    purpose: input.purpose,
    codeHash: input.codeHash,
    attempts: input.attempts,
    expiresAt: input.expiresAt,
    createdAt: input.now,
  });
}

export async function findChallenge(ex: Executor, id: string): Promise<ChallengeRow | undefined> {
  const [row] = await ex.select().from(otpChallenges).where(eq(otpChallenges.id, id));
  return row;
}

/** Makes every open challenge of this user and purpose unusable (a new one is about to be issued). */
export async function invalidateOpenChallenges(
  ex: Executor,
  userId: string,
  purpose: OtpPurpose,
  now: Date,
): Promise<void> {
  await ex
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(and(eq(otpChallenges.userId, userId), eq(otpChallenges.purpose, purpose), isNull(otpChallenges.consumedAt)));
}

/**
 * Counts one wrong code. Returns the new attempt count, or undefined when the challenge is no longer open
 * (consumed, expired or already locked), so the counter can never pass MAX_OTP_ATTEMPTS.
 */
export async function recordFailedAttempt(ex: Executor, id: string, now: Date): Promise<number | undefined> {
  const [row] = await ex
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(
      and(
        eq(otpChallenges.id, id),
        isNull(otpChallenges.consumedAt),
        gt(otpChallenges.expiresAt, now),
        lt(otpChallenges.attempts, MAX_OTP_ATTEMPTS),
      ),
    )
    .returning({ attempts: otpChallenges.attempts });
  return row?.attempts;
}

/** Single-use: exactly one caller gets the row back for an open, unexpired, unlocked challenge. */
export async function consumeChallenge(ex: Executor, id: string, now: Date): Promise<ChallengeRow | undefined> {
  const [row] = await ex
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(
      and(
        eq(otpChallenges.id, id),
        isNull(otpChallenges.consumedAt),
        gt(otpChallenges.expiresAt, now),
        lt(otpChallenges.attempts, MAX_OTP_ATTEMPTS),
      ),
    )
    .returning();
  return row;
}

/** Like consumeChallenge but expired challenges may be replaced; locked and used ones may not. */
export async function retireChallengeForResend(ex: Executor, id: string, now: Date): Promise<ChallengeRow | undefined> {
  const [row] = await ex
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(and(eq(otpChallenges.id, id), isNull(otpChallenges.consumedAt), lt(otpChallenges.attempts, MAX_OTP_ATTEMPTS)))
    .returning();
  return row;
}
