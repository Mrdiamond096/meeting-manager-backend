import { sql } from 'drizzle-orm';
import { check, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, tstz, updatedAt } from './columns.js';

export const USER_ROLES = ['USER'] as const;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored normalized: trimmed + lowercase. */
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: varchar('password_hash', { length: 100 }).notNull(),
    role: varchar('role', { length: 16, enum: USER_ROLES }).notNull().default('USER'),
    emailVerifiedAt: tstz('email_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    check('users_email_normalized', sql`${t.email} = lower(trim(${t.email}))`),
    check('users_role_valid', sql`${t.role} in ('USER')`),
  ],
);
