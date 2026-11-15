import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { feedback, meetings } from '../../db/schema/index.js';

type Executor = Pick<Database, 'select' | 'insert'>;
export function feedbackRepository(db: Executor) {
  return {
    // Prevent deletion between the existence check and insert; an earlier deletion yields 404 instead.
    lockMeeting: async (id: string) => (await db.select({ id: meetings.id }).from(meetings)
      .where(eq(meetings.id, id)).for('key share'))[0],
    create: async (value: typeof feedback.$inferInsert) =>
      (await db.insert(feedback).values(value).returning())[0]!,
  };
}
