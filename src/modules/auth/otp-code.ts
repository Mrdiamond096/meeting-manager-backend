import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Hash stored in otp_challenges.code_hash: HMAC-SHA256 of the code keyed by the challenge id (hex, 64 chars).
 * The 6-digit space is small, so the real protection is the 5-attempt cap per challenge, not the hash strength.
 */
export function hashOtpCode(challengeId: string, code: string): string {
  return createHmac('sha256', challengeId).update(code).digest('hex');
}

export function otpCodeMatches(storedHash: string, challengeId: string, code: string): boolean {
  const expected = Buffer.from(hashOtpCode(challengeId, code));
  const stored = Buffer.from(storedHash);
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}
