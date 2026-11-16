import { compare, hash } from 'bcryptjs';

/** ADR-009: bcrypt cost 12. Tests may pass a lower cost through authRouter options. */
export const BCRYPT_COST = 12;

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hashed: string): Promise<boolean>;
  /**
   * Spends the same time as `verify` on a throwaway hash. Used when the email is unknown so that
   * response time does not reveal whether an account exists.
   */
  verifyAgainstDummy(plain: string): Promise<void>;
}

export function createPasswordHasher(cost: number = BCRYPT_COST): PasswordHasher {
  let dummy: Promise<string> | undefined;
  return {
    hash: (plain) => hash(plain, cost),
    verify: (plain, hashed) => compare(plain, hashed),
    async verifyAgainstDummy(plain) {
      dummy ??= hash('timing-equalizer-not-a-real-password', cost);
      await compare(plain, await dummy);
    },
  };
}
