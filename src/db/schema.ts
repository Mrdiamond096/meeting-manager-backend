import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const MEETING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED'] as const;

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 150 }).notNull(),
    description: text('description').notNull().default(''),
    dueDate: timestamp('due_date', { withTimezone: true, mode: 'date' }).notNull(),
    status: varchar('status', { length: 16, enum: MEETING_STATUSES }).notNull().default('PENDING'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('meetings_due_date_id_idx').on(t.dueDate, t.id),
    check('meetings_title_not_blank', sql`length(trim(${t.title})) > 0`),
    check('meetings_description_max', sql`length(${t.description}) <= 5000`),
    check('meetings_status_valid', sql`${t.status} in ('PENDING', 'CONFIRMED', 'CANCELLED')`),
    check('meetings_version_positive', sql`${t.version} > 0`),
  ],
);
