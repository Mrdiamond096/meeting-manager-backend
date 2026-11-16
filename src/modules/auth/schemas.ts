import { z } from 'zod';

/** ADR-009: trimmed + lowercased, at most 254 characters. */
export const email = z.string().trim().toLowerCase().email().max(254);

/** ADR-009: at least 8 characters, at most 72 bytes (bcrypt truncates silently beyond that). */
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 bytes');

export const challengeId = z.string().uuid();

export const otpCode = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');

export const registerBody = z.object({ email, password }).strict();

/**
 * No length rules on login: a wrong-length password is simply a wrong password (same 401 as any other),
 * and the 72-byte cap only matters when a password is chosen.
 */
export const loginBody = z.object({ email, password: z.string().min(1).max(1024) }).strict();

export const verifyBody = z.object({ challengeId, code: otpCode }).strict();

export const resendBody = z.object({ challengeId }).strict();
