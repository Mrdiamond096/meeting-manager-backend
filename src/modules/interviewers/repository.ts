import type { Executor } from '../../db/client.js';
export const interviewerRepository = (db: Executor) => ({
  search: (query: string) =>
    db.user.findMany({
      where: {
        role: 'INTERVIEWER',
        emailVerifiedAt: { not: null },
        email: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' },
      },
      select: { id: true, email: true },
      orderBy: [{ email: 'asc' }, { id: 'asc' }],
      take: 50,
    }),
});
