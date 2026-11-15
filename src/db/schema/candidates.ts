import { sql } from 'drizzle-orm';
import { check, index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { users } from './users.js';

/** Fixed list shown in the booking form; validated at the API (not a DB enum, so it can grow without a migration). */
export const CANDIDATE_POSITIONS = [
  'Software Engineer',
  'Frontend Engineer',
  'Backend Engineer',
  'Full Stack Engineer',
  'QA Engineer',
  'Data Engineer',
  'DevOps Engineer',
  'Product Designer',
  'Product Manager',
] as const;

export const candidates = pgTable(
  'candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Names may repeat; identity is the id (ADR-006). */
    name: varchar('name', { length: 120 }).notNull(),
    position: varchar('position', { length: 80 }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('candidates_name_idx').on(sql`lower(${t.name})`),
    check('candidates_name_not_blank', sql`length(trim(${t.name})) > 0`),
  ],
);
