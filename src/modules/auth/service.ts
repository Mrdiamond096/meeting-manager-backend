import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../../http/errors.js';
import type { ModuleDeps } from '../deps.js';
import { hashOtpCode, otpCodeMatches } from './otp-code.js';
import type { OtpProvider, OtpPurpose } from './otp-provider.js';
import type { PasswordHasher } from './password.js';
import * as repo from './repository.js';
import { MAX_OTP_ATTEMPTS, type Executor, type UserRow } from './repository.js';
import { MAX_PASSWORD_BYTES } from './schemas.js';
import { createSession, deleteSessionByToken, deleteSessionsOfUser } from './session.js';

/** ADR-009: a challenge lives 5 minutes. */
export const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * Resend budget per user and purpose. It counts challenges rows, not challenge ids, because every resend
 * returns a new id: a limit keyed by id would restart on each resend and never bite.
 */
export const RESEND_WINDOW_MS = 15 * 60 * 1000;
export const MAX_RESENDS_PER_WINDOW = 3;

/**
 * Reset codes issued per user per hour, counted in the database. The per-IP+email limiter in the router stops one
 * client; this stops many clients from mailing codes to one victim.
 */
export const RESET_WINDOW_MS = 60 * 60 * 1000;
export const MAX_RESETS_PER_WINDOW = 5;

export interface AuthServiceDeps extends ModuleDeps {
  otp: OtpProvider;
  hasher: PasswordHasher;
}

export interface IssuedChallenge {
  challengeId: string;
  expiresAt: Date;
}

export interface SignedIn {
  user: UserRow;
  session: { token: string; expiresAt: Date };
}

/** OTP_INVALID carries the remaining attempts so the UI can show them (contract §3). */
function otpInvalid(attemptsRemaining: number): AppError {
  return new AppError('OTP_INVALID', undefined, [{ path: 'attemptsRemaining', message: String(attemptsRemaining) }]);
}

export function createAuthService({ db, now, otp, hasher }: AuthServiceDeps) {
  /** Stores a new challenge. The caller delivers the returned code after the surrounding transaction commits. */
  async function issueChallenge(
    ex: Executor,
    input: { userId: string; purpose: OtpPurpose; attempts?: number },
    at: Date,
  ) {
    const id = randomUUID();
    const code = otp.generateCode();
    const expiresAt = new Date(at.getTime() + OTP_TTL_MS);
    await repo.insertChallenge(ex, {
      id,
      userId: input.userId,
      purpose: input.purpose,
      codeHash: hashOtpCode(id, code),
      attempts: input.attempts ?? 0,
      expiresAt,
      now: at,
    });
    return { challengeId: id, expiresAt, code };
  }

  return {
    /** Creates the account (or replaces the password of an unverified one) and issues a REGISTER challenge. */
    async register(input: { email: string; password: string }): Promise<IssuedChallenge> {
      const at = now();
      // Hash first so a taken email costs the same time as a free one.
      const passwordHash = await hasher.hash(input.password);

      const { issued, userId } = await db.$transaction(async (tx) => {
        const user = await repo.upsertUnverifiedUser(tx, { email: input.email, passwordHash, now: at });
        if (!user) throw new AppError('EMAIL_TAKEN');
        await repo.invalidateOpenChallenges(tx, user.id, 'REGISTER', at);
        return { issued: await issueChallenge(tx, { userId: user.id, purpose: 'REGISTER' }, at), userId: user.id };
      });

      await otp.deliver({ userId, purpose: 'REGISTER' }, issued.code);
      return { challengeId: issued.challengeId, expiresAt: issued.expiresAt };
    },

    /**
     * First factor of login (ADR-009): checks the password and issues a LOGIN challenge. No session yet; the
     * session only exists after /otp/verify. Unknown email and wrong password are indistinguishable.
     */
    async login(input: { email: string; password: string }): Promise<IssuedChallenge> {
      const user = await repo.findUserByEmail(db, input.email);
      // bcrypt silently ignores everything past 72 bytes, so a longer password would "match" its own prefix.
      // Registration refuses such passwords, so one can never be right: answer like any wrong password.
      if (!user || Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
        await hasher.verifyAgainstDummy(input.password);
        throw new AppError('INVALID_CREDENTIALS');
      }
      if (!(await hasher.verify(input.password, user.passwordHash))) throw new AppError('INVALID_CREDENTIALS');

      const at = now();
      const issued = await db.$transaction(async (tx) => {
        await repo.lockUser(tx, user.id); // lock order: user, then challenge (see repo.lockUser)
        await repo.invalidateOpenChallenges(tx, user.id, 'LOGIN', at);
        return issueChallenge(tx, { userId: user.id, purpose: 'LOGIN' }, at);
      });

      await otp.deliver({ userId: user.id, purpose: 'LOGIN' }, issued.code);
      return { challengeId: issued.challengeId, expiresAt: issued.expiresAt };
    },

    /**
     * Starts a password reset. The answer is the same shape whether or not the email has an account, and for a
     * known account whose reset budget is used up: the fake challenge id simply never verifies.
     */
    async forgotPassword(log: Logger, input: { email: string }): Promise<IssuedChallenge> {
      const at = now();
      const fake = (): IssuedChallenge => ({ challengeId: randomUUID(), expiresAt: new Date(at.getTime() + OTP_TTL_MS) });

      const user = await repo.findUserByEmail(db, input.email);
      if (!user) return fake();

      const issued = await db.$transaction(async (tx) => {
        await repo.lockUser(tx, user.id); // lock order: user, then challenge (see repo.lockUser)
        const recent = await repo.countChallengesSince(tx, user.id, 'RESET', new Date(at.getTime() - RESET_WINDOW_MS));
        if (recent >= MAX_RESETS_PER_WINDOW) return undefined;
        await repo.invalidateOpenChallenges(tx, user.id, 'RESET', at);
        return issueChallenge(tx, { userId: user.id, purpose: 'RESET' }, at);
      });
      if (!issued) {
        log.warn({ userId: user.id }, 'password reset budget used up, no code issued');
        return fake();
      }

      await otp.deliver({ userId: user.id, purpose: 'RESET' }, issued.code);
      return { challengeId: issued.challengeId, expiresAt: issued.expiresAt };
    },

    /**
     * Finishes a reset: checks the RESET code, replaces the password and signs the user out everywhere.
     * Every failure is a plain OTP_INVALID without attemptsRemaining. A counter would tell a real challenge
     * from the fake one forgotPassword hands out for unknown emails.
     */
    async resetPassword(log: Logger, input: { challengeId: string; code: string; newPassword: string }): Promise<void> {
      const at = now();
      const invalid = () => new AppError('OTP_INVALID');
      const challenge = await repo.findChallenge(db, input.challengeId);
      const open =
        challenge &&
        challenge.purpose === 'RESET' &&
        !challenge.consumedAt &&
        challenge.expiresAt > at &&
        challenge.attempts < MAX_OTP_ATTEMPTS;
      if (!challenge || !open) throw invalid();

      if (!otpCodeMatches(challenge.codeHash, challenge.id, input.code)) {
        const attempts = await repo.recordFailedAttempt(db, challenge.id, at);
        if (attempts !== undefined && attempts >= MAX_OTP_ATTEMPTS) {
          log.warn(
            { challengeId: challenge.id, userId: challenge.userId, purpose: challenge.purpose },
            'otp challenge locked after too many wrong codes',
          );
        }
        throw invalid();
      }

      // Slow, so it runs before the transaction instead of while the user row is locked.
      const passwordHash = await hasher.hash(input.newPassword);
      await db.$transaction(async (tx) => {
        await repo.lockUser(tx, challenge.userId); // lock order: user, then challenge (see repo.lockUser)
        const consumed = await repo.consumeChallenge(tx, challenge.id, at);
        if (!consumed) throw invalid();
        await repo.updatePasswordHash(tx, consumed.userId, passwordHash, at);
        // The code went to the account's email, so using it proves the email (as on login).
        await repo.markEmailVerified(tx, consumed.userId, at);
        await repo.invalidateAllOpenChallenges(tx, consumed.userId, at);
        await deleteSessionsOfUser(tx, consumed.userId);
      });
    },

    /** Idempotent: an absent, malformed or unknown token is not an error. */
    async logout(token: string | undefined): Promise<void> {
      if (token) await deleteSessionByToken(db, token);
    },

    async currentUser(userId: string): Promise<UserRow> {
      const user = await repo.findUserById(db, userId);
      if (!user) throw new AppError('UNAUTHENTICATED');
      return user;
    },

    /** Checks a REGISTER or LOGIN code; on success marks the email verified and opens a session. */
    async verifyOtp(log: Logger, input: { challengeId: string; code: string }): Promise<SignedIn> {
      const at = now();
      const challenge = await repo.findChallenge(db, input.challengeId);
      const open =
        challenge &&
        challenge.purpose !== 'RESET' &&
        !challenge.consumedAt &&
        challenge.expiresAt > at &&
        challenge.attempts < MAX_OTP_ATTEMPTS;
      if (!challenge || !open) throw otpInvalid(0);

      if (!otpCodeMatches(challenge.codeHash, challenge.id, input.code)) {
        const attempts = await repo.recordFailedAttempt(db, challenge.id, at);
        if (attempts === undefined) throw otpInvalid(0);
        if (attempts >= MAX_OTP_ATTEMPTS) {
          log.warn(
            { challengeId: challenge.id, userId: challenge.userId, purpose: challenge.purpose },
            'otp challenge locked after too many wrong codes',
          );
        }
        throw otpInvalid(MAX_OTP_ATTEMPTS - attempts);
      }

      return db.$transaction(async (tx) => {
        await repo.lockUser(tx, challenge.userId); // lock order: user, then challenge (see repo.lockUser)
        const consumed = await repo.consumeChallenge(tx, challenge.id, at);
        if (!consumed) throw otpInvalid(0);
        // The code was delivered to the account's email, so entering it proves the email (also on login).
        await repo.markEmailVerified(tx, consumed.userId, at);
        const user = await repo.findUserById(tx, consumed.userId);
        if (!user) throw otpInvalid(0);
        return { user, session: await createSession(tx, user.id, at) };
      });
    },

    /**
     * Replaces an open (or merely expired) challenge with a fresh code.
     * - Wrong-code attempts carry over, so resending cannot be used to get unlimited guesses.
     * - At most MAX_RESENDS_PER_WINDOW resends per user and purpose per RESEND_WINDOW_MS, counted in the database
     *   so chaining the new ids cannot restart the budget.
     */
    async resend(input: { challengeId: string }): Promise<IssuedChallenge> {
      const at = now();
      const known = await repo.findChallenge(db, input.challengeId);
      // A reset challenge is never resent: forgot answers with a fake id for unknown emails, and a working
      // resend would tell the two apart. The user asks for a new code through forgot instead.
      if (!known || known.purpose === 'RESET') throw otpInvalid(0);

      const { issued, userId, purpose } = await db.$transaction(async (tx) => {
        // Lock order: user, then challenge (see repo.lockUser). It also serializes concurrent resends of one
        // account, so the count below cannot be raced past the limit.
        await repo.lockUser(tx, known.userId);
        const retired = await repo.retireChallengeForResend(tx, input.challengeId, at);
        if (!retired) throw otpInvalid(0);

        // The challenge being replaced is itself in the count: one original + MAX_RESENDS resends is the ceiling.
        const issuedRecently = await repo.countChallengesSince(
          tx,
          retired.userId,
          retired.purpose,
          new Date(at.getTime() - RESEND_WINDOW_MS),
        );
        if (issuedRecently > MAX_RESENDS_PER_WINDOW) throw new AppError('RATE_LIMITED'); // rolls the retire back

        const next = await issueChallenge(
          tx,
          { userId: retired.userId, purpose: retired.purpose, attempts: retired.attempts },
          at,
        );
        return { issued: next, userId: retired.userId, purpose: retired.purpose };
      });

      await otp.deliver({ userId, purpose }, issued.code);
      return { challengeId: issued.challengeId, expiresAt: issued.expiresAt };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
