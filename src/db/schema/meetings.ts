import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { candidates } from './candidates.js';
import { createdAt, tstz, updatedAt } from './columns.js';
import { users } from './users.js';

export const MEETING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED'] as const;
export const MEETING_TYPES = ['ONSITE', 'ONLINE'] as const;
export const MEETING_PROVIDERS = ['ZOOM', 'GOOGLE_MEET', 'OTHER'] as const;

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id').references(() => candidates.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 150 }).notNull(),
    description: text('description').notNull().default(''),
    /** Meeting start instant (ADR-005). */
    dueDate: tstz('due_date').notNull(),
    endAt: tstz('end_at'),
    status: varchar('status', { length: 16, enum: MEETING_STATUSES }).notNull().default('PENDING'),
    meetingType: varchar('meeting_type', { length: 16, enum: MEETING_TYPES }),
    provider: varchar('provider', { length: 16, enum: MEETING_PROVIDERS }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('meetings_due_date_id_idx').on(t.dueDate, t.id),
    index('meetings_candidate_due_date_idx').on(t.candidateId, t.dueDate, t.id),
    index('meetings_created_by_due_date_idx').on(t.createdBy, t.dueDate, t.id),
    check('meetings_title_not_blank', sql`length(trim(${t.title})) > 0`),
    check('meetings_description_max', sql`length(${t.description}) <= 5000`),
    check('meetings_status_valid', sql`${t.status} in ('PENDING', 'CONFIRMED', 'CANCELLED')`),
    check('meetings_version_positive', sql`${t.version} > 0`),
    check('meetings_end_after_start', sql`${t.endAt} is null or ${t.endAt} > ${t.dueDate}`),
    check('meetings_type_valid', sql`${t.meetingType} is null or ${t.meetingType} in ('ONSITE', 'ONLINE')`),
    check('meetings_provider_valid', sql`${t.provider} is null or ${t.provider} in ('ZOOM', 'GOOGLE_MEET', 'OTHER')`),
    check('meetings_provider_only_online', sql`${t.provider} is null or ${t.meetingType} = 'ONLINE'`),
  ],
);
