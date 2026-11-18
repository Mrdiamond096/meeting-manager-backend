import type { Executor } from '../../db/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ListMeetings } from './schemas.js';

export const meetingInclude = {
  candidate: true,
  interviewers: {
    include: { user: { select: { id: true, email: true } } },
    orderBy: { user: { email: 'asc' } },
  },
} satisfies Prisma.MeetingInclude;
type MeetingRecord = Prisma.MeetingGetPayload<{ include: typeof meetingInclude }>;
export interface MeetingRow {
  meeting: Omit<MeetingRecord, 'candidate' | 'interviewers'>;
  candidate: MeetingRecord['candidate'];
  interviewers: { id: string; email: string }[];
}
export const toMeetingRow = ({
  candidate,
  interviewers,
  ...meeting
}: MeetingRecord): MeetingRow => ({
  meeting,
  candidate,
  interviewers: interviewers.map((assignment) => assignment.user),
});

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
    ...('view' in query
      ? overlapping(query.from, query.to)
      : { dueDate: { gte: query.from, lt: query.to } }),
    createdBy: query.mine ? userId : undefined,
    interviewers: query.assignedToMe ? { some: { userId } } : undefined,
    candidateId: 'candidateId' in query ? query.candidateId : undefined,
  });
  return {
    find: async (id: string) => {
      const row = await db.meeting.findUnique({ where: { id }, include: meetingInclude });
      return row ? toMeetingRow(row) : null;
    },
    list: async (query: ListMeetings, userId: string, limit: number, offset = 0) =>
      (
        await db.meeting.findMany({
          where: predicate(query, userId),
          include: meetingInclude,
          orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
          take: limit,
          skip: offset,
        })
      ).map(toMeetingRow),
    total: (query: ListMeetings, userId: string) =>
      db.meeting.count({ where: predicate(query, userId) }),
    candidate: (id: string) => db.candidate.findUnique({ where: { id } }),
    insertCandidate: (data: Prisma.CandidateUncheckedCreateInput) => db.candidate.create({ data }),
    insert: (data: Prisma.MeetingUncheckedCreateInput) => db.meeting.create({ data }),
    eligibleInterviewers: (ids: string[]) =>
      db.user.findMany({
        where: { id: { in: ids }, role: 'INTERVIEWER', emailVerifiedAt: { not: null } },
        select: { id: true },
      }),
    replaceInterviewers: async (meetingId: string, ids: string[], assignedAt: Date) => {
      await db.meetingInterviewer.deleteMany({ where: { meetingId } });
      if (ids.length)
        await db.meetingInterviewer.createMany({
          data: ids.map((userId) => ({ meetingId, userId, assignedAt })),
        });
    },
    update: async (id: string, version: number, data: Prisma.MeetingUncheckedUpdateManyInput) => {
      const [updated] = await db.meeting.updateManyAndReturn({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      return updated;
    },
    remove: async (id: string, version: number) =>
      (await db.meeting.deleteMany({ where: { id, version } })).count > 0,
    feedback: (id: string) =>
      db.feedback.findMany({
        where: { meetingId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
  };
}
