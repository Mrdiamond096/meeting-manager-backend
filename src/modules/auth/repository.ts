import type { Executor } from '../../db/client.js';
import type { OtpChallenge, User } from '../../generated/prisma/client.js';
import type { OtpPurpose } from './otp-provider.js';

export type { Executor };
export type UserRow = User;
/** `purpose` is a varchar guarded by a CHECK constraint, so narrowing it to the union is safe. */
export type ChallengeRow = OtpChallenge & { purpose: OtpPurpose };

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
  // Prisma's upsert cannot carry the `where email_verified_at is null` guard, so this stays one raw statement.
  const [row] = await ex.$queryRaw<UserRow[]>`
    insert into users (email, password_hash, created_at, updated_at)
    values (${input.email}, ${input.passwordHash}, ${input.now}, ${input.now})
    on conflict (email) do update
      set password_hash = excluded.password_hash, updated_at = ${input.now}
      where users.email_verified_at is null
    returning id, email, password_hash as "passwordHash", role, email_verified_at as "emailVerifiedAt",
      created_at as "createdAt", updated_at as "updatedAt"`;
  return row;
}

/**
 * LOCK ORDER: every transaction that touches both a user and its challenges takes the user lock first, then the
 * challenge rows. register already works that way (the user upsert comes first), so verify and resend call this
 * before they touch a challenge. Taking them in the opposite order lets two requests wait on each other and
 * PostgreSQL aborts one with 40P01 (deadlock), which would surface as a 500.
 *
 * NO KEY UPDATE conflicts with the user updates register/verify perform, but not with the KEY SHARE lock that
 * inserting a challenge takes through its foreign key.
 */
export async function lockUser(ex: Executor, userId: string): Promise<void> {
  await ex.$queryRaw`select id from users where id = ${userId}::uuid for no key update`;
}

export async function findUserByEmail(ex: Executor, email: string): Promise<UserRow | undefined> {
  return (await ex.user.findUnique({ where: { email } })) ?? undefined;
}

export async function findUserById(ex: Executor, id: string): Promise<UserRow | undefined> {
  return (await ex.user.findUnique({ where: { id } })) ?? undefined;
}

export async function markEmailVerified(ex: Executor, userId: string, now: Date): Promise<void> {
  await ex.user.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: now, updatedAt: now },
  });
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
  await ex.otpChallenge.create({
    data: {
      id: input.id,
      userId: input.userId,
      purpose: input.purpose,
      codeHash: input.codeHash,
      attempts: input.attempts,
      expiresAt: input.expiresAt,
      createdAt: input.now,
    },
  });
}

export async function findChallenge(ex: Executor, id: string): Promise<ChallengeRow | undefined> {
  return ((await ex.otpChallenge.findUnique({ where: { id } })) as ChallengeRow | null) ?? undefined;
}

/** Makes every open challenge of this user and purpose unusable (a new one is about to be issued). */
export async function invalidateOpenChallenges(
  ex: Executor,
  userId: string,
  purpose: OtpPurpose,
  now: Date,
): Promise<void> {
  await ex.otpChallenge.updateMany({ where: { userId, purpose, consumedAt: null }, data: { consumedAt: now } });
}

/** Challenges issued to this user for this purpose since `since`, including retired ones (stable across resends). */
export async function countChallengesSince(
  ex: Executor,
  userId: string,
  purpose: OtpPurpose,
  since: Date,
): Promise<number> {
  return ex.otpChallenge.count({ where: { userId, purpose, createdAt: { gt: since } } });
}

/**
 * Counts one wrong code. Returns the new attempt count, or undefined when the challenge is no longer open
 * (consumed, expired or already locked), so the counter can never pass MAX_OTP_ATTEMPTS.
 */
export async function recordFailedAttempt(ex: Executor, id: string, now: Date): Promise<number | undefined> {
  const [row] = await ex.otpChallenge.updateManyAndReturn({
    where: { id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  return row?.attempts;
}

/** Single-use: exactly one caller gets the row back for an open, unexpired, unlocked challenge. */
export async function consumeChallenge(ex: Executor, id: string, now: Date): Promise<ChallengeRow | undefined> {
  const [row] = await ex.otpChallenge.updateManyAndReturn({
    where: { id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { consumedAt: now },
  });
  return row as ChallengeRow | undefined;
}

/** Like consumeChallenge but expired challenges may be replaced; locked and used ones may not. */
export async function retireChallengeForResend(ex: Executor, id: string, now: Date): Promise<ChallengeRow | undefined> {
  const [row] = await ex.otpChallenge.updateManyAndReturn({
    where: { id, consumedAt: null, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { consumedAt: now },
  });
  return row as ChallengeRow | undefined;
}
