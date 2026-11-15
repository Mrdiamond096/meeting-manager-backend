import type { OTP_PURPOSES } from '../../db/schema/otp-challenges.js';
import type { Config } from '../../config.js';

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export interface OtpDelivery {
  userId: string;
  purpose: OtpPurpose;
}

/** Source and transport of one-time codes. A real provider would generate a random code and send it by email/SMS. */
export interface OtpProvider {
  generateCode(): string;
  deliver(target: OtpDelivery, code: string): Promise<void>;
}

/** Demo provider (ADR-009): always issues OTP_MOCK_CODE and delivers nothing. Refused in production by loadConfig. */
export class MockOtpProvider implements OtpProvider {
  constructor(private readonly code: string) {}

  generateCode(): string {
    return this.code;
  }

  async deliver(): Promise<void> {
    // Nothing to send: the code is public by design (README documents the mock).
  }
}

export function createOtpProvider(otp: Config['otp']): OtpProvider {
  return new MockOtpProvider(otp.mockCode);
}
