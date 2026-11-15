import type { Prisma } from '../../src/generated/prisma/client.js';
import { db } from '../../src/db/client.js';

export { db as testDb };

/** Empties every table. Call in beforeEach of DB-backed tests (files run sequentially). */
export async function resetDb(): Promise<void> {
  await db.$executeRaw`truncate table feedback, meetings, candidates, otp_challenges, sessions, users restart identity cascade`;
}

let seq = 0;

export async function createUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  seq += 1;
  return db.user.create({
    data: {
      email: `user${seq}-${Date.now()}@example.test`,
      // Not a real hash: stubbed-auth tests never verify passwords.
      passwordHash: 'stub',
      emailVerifiedAt: new Date(),
      ...overrides,
    },
  });
}
