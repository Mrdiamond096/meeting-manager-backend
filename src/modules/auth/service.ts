import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError } from '../../http/errors.js';
import type { ModuleDeps } from '../deps.js';
import { hashOtpCode, otpCodeMatches } from './otp-code.js';
import type { OtpProvider, OtpPurpose } from './otp-provider.js';
import type { PasswordHasher } from './password.js';
import * as repo from './repository.js';
import { MAX_OTP_ATTEMPTS, type Executor, type UserRow } from './repository.js';
import { createSession } from './session.js';

/** ADR-009: a challenge lives 5 minutes. */
export const OTP_TTL_MS = 5 * 60 * 1000;

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

      const { issued, userId } = await db.transaction(async (tx) => {
        const user = await repo.upsertUnverifiedUser(tx, { email: input.email, passwordHash, now: at });
        if (!user) throw new AppError('EMAIL_TAKEN');
        await repo.invalidateOpenChallenges(tx, user.id, 'REGISTER', at);
        return { issued: await issueChallenge(tx, { userId: user.id, purpose: 'REGISTER' }, at), userId: user.id };
      });

      await otp.deliver({ userId, purpose: 'REGISTER' }, issued.code);
      return { challengeId: issued.challengeId, expiresAt: issued.expiresAt };
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

      return db.transaction(async (tx) => {
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
     * Wrong-code attempts carry over, so resending cannot be used to get unlimited guesses.
     */
    async resend(input: { challengeId: string }): Promise<IssuedChallenge> {
      const at = now();
      const { issued, userId, purpose } = await db.transaction(async (tx) => {
        const retired = await repo.retireChallengeForResend(tx, input.challengeId, at);
        if (!retired) throw otpInvalid(0);
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
