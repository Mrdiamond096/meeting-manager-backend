import { and, asc, desc, eq, gte, ilike, lt, ne, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { candidates, meetings } from '../../db/schema/index.js';

export function candidateRepository(db: Database) {
  return {
    search: (query: string) => db.select().from(candidates)
      .where(ilike(candidates.name, `%${query.replace(/[\\%_]/g, '\\$&')}%`))
      .orderBy(desc(candidates.createdAt), desc(candidates.id)).limit(10),
    find: async (id: string) => (await db.select().from(candidates).where(eq(candidates.id, id)).limit(1))[0],
    create: async (value: typeof candidates.$inferInsert) =>
      (await db.insert(candidates).values(value).returning())[0]!,
    upcoming: (id: string, now: Date) => db.select().from(meetings)
      .where(and(eq(meetings.candidateId, id), gte(meetings.dueDate, now), ne(meetings.status, 'CANCELLED')))
      .orderBy(asc(meetings.dueDate), asc(meetings.id)),
    history: (id: string, now: Date) => db.select().from(meetings)
      .where(and(eq(meetings.candidateId, id), or(lt(meetings.dueDate, now), eq(meetings.status, 'CANCELLED'))))
      .orderBy(desc(meetings.dueDate), desc(meetings.id)),
  };
}
