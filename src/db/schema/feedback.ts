import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { meetings } from './meetings.js';
import { users } from './users.js';

/** Append-only interview notes (no update/delete endpoints). */
export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('feedback_meeting_created_at_idx').on(t.meetingId, t.createdAt),
    check('feedback_body_length', sql`length(trim(${t.body})) between 1 and 5000`),
  ],
);
