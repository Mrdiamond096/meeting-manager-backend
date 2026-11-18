import type { Executor } from '../../db/client.js';
import { meetingInclude } from '../meetings/repository.js';
import type { Prisma } from '../../generated/prisma/client.js';

export function candidateRepository(db: Executor) {
  return {
    search: (query: string) =>
      db.candidate.findMany({
        // Prisma passes LIKE wildcards through unescaped, so treat user text literally here.
        where: { name: { contains: query.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
      }),
    find: (id: string) => db.candidate.findUnique({ where: { id } }),
    create: (data: Prisma.CandidateUncheckedCreateInput) => db.candidate.create({ data }),
    upcoming: (id: string, now: Date) =>
      db.meeting.findMany({
        include: meetingInclude,
        where: { candidateId: id, dueDate: { gte: now }, status: { not: 'CANCELLED' } },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      }),
    history: (id: string, now: Date) =>
      db.meeting.findMany({
        include: meetingInclude,
        where: { candidateId: id, OR: [{ dueDate: { lt: now } }, { status: 'CANCELLED' }] },
        orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
      }),
  };
}
