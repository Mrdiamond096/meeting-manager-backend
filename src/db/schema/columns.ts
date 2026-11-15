import { timestamp } from 'drizzle-orm/pg-core';

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => tstz('created_at').notNull().defaultNow();
export const updatedAt = () => tstz('updated_at').notNull().defaultNow();
