import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema/index.js';

export { db as testDb };

/** Empties every table. Call in beforeEach of DB-backed tests (files run sequentially). */
export async function resetDb(): Promise<void> {
  await db.execute(
    sql`truncate table feedback, meetings, candidates, otp_challenges, sessions, users restart identity cascade`,
  );
}

let seq = 0;

export async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  seq += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: `user${seq}-${Date.now()}@example.test`,
      // Not a real hash: stubbed-auth tests never verify passwords.
      passwordHash: 'stub',
      emailVerifiedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!user) throw new Error('failed to create test user');
  return user;
}
