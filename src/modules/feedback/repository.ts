import type { Executor } from '../../db/client.js';
import type { Prisma } from '../../generated/prisma/client.js';

export function feedbackRepository(db: Executor) {
  return {
    // Prevent deletion between the existence check and insert; an earlier deletion yields 404 instead.
    lockMeeting: async (id: string) =>
      (
        await db.$queryRaw<{ id: string }[]>`
      select id from meetings where id = ${id}::uuid for key share`
      )[0],
    create: (data: Prisma.FeedbackUncheckedCreateInput) => db.feedback.create({ data }),
  };
}
