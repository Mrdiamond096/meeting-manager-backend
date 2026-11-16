import { compare, hash } from 'bcryptjs';

/** ADR-009: bcrypt cost 12. Tests may pass a lower cost through authRouter options. */
export const BCRYPT_COST = 12;

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hashed: string): Promise<boolean>;
}

export function createPasswordHasher(cost: number = BCRYPT_COST): PasswordHasher {
  return {
    hash: (plain) => hash(plain, cost),
    verify: (plain, hashed) => compare(plain, hashed),
  };
}
