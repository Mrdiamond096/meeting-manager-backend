import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, tstz } from './columns.js';
import { users } from './users.js';

export const OTP_PURPOSES = ['REGISTER', 'LOGIN', 'RESET'] as const;

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 16, enum: OTP_PURPOSES }).notNull(),
    codeHash: varchar('code_hash', { length: 100 }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('otp_challenges_user_purpose_idx').on(t.userId, t.purpose),
    check('otp_challenges_purpose_valid', sql`${t.purpose} in ('REGISTER', 'LOGIN', 'RESET')`),
    check('otp_challenges_attempts_range', sql`${t.attempts} between 0 and 5`),
  ],
);
