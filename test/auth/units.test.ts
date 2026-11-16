import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { hashOtpCode, otpCodeMatches } from '../../src/modules/auth/otp-code.js';
import { createOtpProvider, MockOtpProvider } from '../../src/modules/auth/otp-provider.js';
import { BCRYPT_COST, createPasswordHasher } from '../../src/modules/auth/password.js';
import { hashSessionToken } from '../../src/modules/auth/session.js';

describe('password hasher', () => {
  it('uses bcrypt cost 12 by default (ADR-009)', async () => {
    expect(BCRYPT_COST).toBe(12);
    const hashed = await createPasswordHasher().hash('correct horse battery');
    expect(hashed).toMatch(/^\$2[aby]\$12\$/);
  });

  it('verifies the right password only, and salts every hash', async () => {
    const hasher = createPasswordHasher(4);
    const a = await hasher.hash('correct horse battery');
    const b = await hasher.hash('correct horse battery');
    expect(a).not.toBe(b);
    expect(await hasher.verify('correct horse battery', a)).toBe(true);
    expect(await hasher.verify('Correct horse battery', a)).toBe(false);
  });
});

describe('OTP code hash', () => {
  it('matches only the same code for the same challenge', () => {
    const id = randomUUID();
    const stored = hashOtpCode(id, '112233');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(otpCodeMatches(stored, id, '112233')).toBe(true);
    expect(otpCodeMatches(stored, id, '112234')).toBe(false);
    expect(otpCodeMatches(stored, randomUUID(), '112233')).toBe(false);
  });

  it('does not throw on a stored hash of unexpected length', () => {
    expect(otpCodeMatches('short', randomUUID(), '112233')).toBe(false);
  });
});

describe('session token hash', () => {
  it('is a deterministic SHA-256 hex digest', () => {
    expect(hashSessionToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('OTP provider', () => {
  it('builds the mock provider from config, using OTP_MOCK_CODE', () => {
    const provider = createOtpProvider(loadConfig({ OTP_MOCK_CODE: '445566' }).otp);
    expect(provider).toBeInstanceOf(MockOtpProvider);
    expect(provider.generateCode()).toBe('445566');
  });
});
