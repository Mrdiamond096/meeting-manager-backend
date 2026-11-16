import type { Executor } from '../../db/client.js';
import type { Candidate, Meeting, Prisma } from '../../generated/prisma/client.js';
import type { ListMeetings } from './schemas.js';

export interface MeetingRow {
  meeting: Meeting;
  candidate: Candidate | null;
}

const toRow = ({ candidate, ...meeting }: Meeting & { candidate: Candidate | null }): MeetingRow =>
  ({ meeting, candidate });

/** A meeting without `endAt` lasts this long on the calendar (contract: range view; same as the frontend). */
export const RANGE_DEFAULT_MINUTES = 30;

/**
 * Range view (calendar): meetings that overlap [from, to), i.e. start before `to` and end after `from`, so a meeting
 * that started earlier and is still running shows up. `coalesce(endAt, dueDate + 30 min) > from` written as an OR.
 */
const overlapping = (from: Date, to: Date): Prisma.MeetingWhereInput => ({
  dueDate: { lt: to },
  OR: [
    { endAt: { gt: from } },
    { endAt: null, dueDate: { gt: new Date(from.getTime() - RANGE_DEFAULT_MINUTES * 60_000) } },
  ],
});

export function meetingRepository(db: Executor) {
  const predicate = (query: ListMeetings, userId: string): Prisma.MeetingWhereInput => ({
    status: query.status,
    ...('view' in query ? overlapping(query.from, query.to) : { dueDate: { gte: query.from, lt: query.to } }),
    createdBy: query.mine ? userId : undefined,
    candidateId: 'candidateId' in query ? query.candidateId : undefined,
  });
  return {
    find: async (id: string) => {
      const row = await db.meeting.findUnique({ where: { id }, include: { candidate: true } });
      return row ? toRow(row) : null;
    },
    list: async (query: ListMeetings, userId: string, limit: number, offset = 0) =>
      (await db.meeting.findMany({
        where: predicate(query, userId), include: { candidate: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: limit, skip: offset,
      })).map(toRow),
    total: (query: ListMeetings, userId: string) => db.meeting.count({ where: predicate(query, userId) }),
    candidate: (id: string) => db.candidate.findUnique({ where: { id } }),
    insertCandidate: (data: Prisma.CandidateUncheckedCreateInput) => db.candidate.create({ data }),
    insert: (data: Prisma.MeetingUncheckedCreateInput) => db.meeting.create({ data }),
    update: async (id: string, version: number, data: Prisma.MeetingUncheckedUpdateManyInput) =>
      (await db.meeting.updateManyAndReturn({
        where: { id, version }, data: { ...data, version: { increment: 1 } },
      }))[0],
    remove: async (id: string, version: number) => (await db.meeting.deleteMany({ where: { id, version } })).count > 0,
    feedback: (id: string) => db.feedback.findMany({
      where: { meetingId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  };
}
