import { and, asc, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { candidates, feedback, meetings } from '../../db/schema/index.js';
import type { ListMeetings } from './schemas.js';

type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
export interface MeetingRow {
  meeting: typeof meetings.$inferSelect;
  candidate: typeof candidates.$inferSelect | null;
}

export function meetingRepository(db: Executor) {
  const joined = () => db.select({ meeting: meetings, candidate: candidates })
    .from(meetings).leftJoin(candidates, eq(meetings.candidateId, candidates.id));
  const predicate = (query: ListMeetings, userId: string) => {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(meetings.status, query.status));
    if (query.from) conditions.push(gte(meetings.dueDate, query.from));
    if (query.to) conditions.push(lt(meetings.dueDate, query.to));
    if (query.mine) conditions.push(eq(meetings.createdBy, userId));
    if ('candidateId' in query && query.candidateId) conditions.push(eq(meetings.candidateId, query.candidateId));
    return and(...conditions);
  };
  return {
    find: async (id: string) => (await joined().where(eq(meetings.id, id)).limit(1))[0],
    list: (query: ListMeetings, userId: string, limit: number, offset = 0) => joined()
      .where(predicate(query, userId)).orderBy(asc(meetings.dueDate), asc(meetings.id)).limit(limit).offset(offset),
    total: async (query: ListMeetings, userId: string) =>
      (await db.select({ value: count() }).from(meetings).where(predicate(query, userId)))[0]!.value,
    candidate: async (id: string) => (await db.select().from(candidates).where(eq(candidates.id, id)).limit(1))[0],
    insertCandidate: async (value: typeof candidates.$inferInsert) =>
      (await db.insert(candidates).values(value).returning())[0]!,
    insert: async (value: typeof meetings.$inferInsert) => (await db.insert(meetings).values(value).returning())[0]!,
    update: async (id: string, version: number, value: Partial<typeof meetings.$inferInsert>) =>
      (await db.update(meetings).set({ ...value, version: sql`${meetings.version} + 1` })
        .where(and(eq(meetings.id, id), sql`${meetings.version} = ${version}::bigint`)).returning())[0],
    remove: async (id: string, version: number) => (await db.delete(meetings)
      .where(and(eq(meetings.id, id), sql`${meetings.version} = ${version}::bigint`)).returning({ id: meetings.id }))[0],
    feedback: (id: string) => db.select().from(feedback).where(eq(feedback.meetingId, id))
      .orderBy(desc(feedback.createdAt), desc(feedback.id)),
  };
}
