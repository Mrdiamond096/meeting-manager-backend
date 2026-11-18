import type { AuthUser } from '../../http/auth-guard.js';
import { AppError } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { toMeeting } from './mapper.js';
import { toFeedback } from '../feedback/mapper.js';
import { meetingRepository } from './repository.js';
import {
  meetingState,
  type CreateMeeting,
  type ListMeetings,
  type PatchMeeting,
} from './schemas.js';

export function meetingService(deps: ModuleDeps) {
  const repo = meetingRepository(deps.db);
  const requireMeeting = async (id: string) => {
    const row = await repo.find(id);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  };
  const stale = async (id: string): Promise<never> => {
    await requireMeeting(id);
    throw new AppError('VERSION_CONFLICT');
  };
  const checkVersion = (actual: number, expected: number) => {
    if (actual !== expected) throw new AppError('VERSION_CONFLICT');
  };
  const requireManage = (row: Awaited<ReturnType<typeof requireMeeting>>, user: AuthUser) => {
    if (user.role === 'INTERVIEWER' && !row.interviewers.some((person) => person.id === user.id))
      throw new AppError('FORBIDDEN');
  };
  const validateInterviewers = async (
    repository: ReturnType<typeof meetingRepository>,
    ids: string[],
  ) => {
    if ((await repository.eligibleInterviewers(ids)).length !== ids.length)
      throw new AppError('VALIDATION_ERROR', undefined, [
        { path: 'body.interviewerIds', message: 'Choose verified interviewer accounts' },
      ]);
  };
  const validateState = (m: {
    dueDate: Date;
    endAt?: Date | null;
    meetingType?: string | null;
    provider?: string | null;
  }) =>
    parse(
      meetingState,
      {
        dueDate: m.dueDate,
        endAt: m.endAt ?? null,
        meetingType: m.meetingType ?? null,
        provider: m.provider ?? null,
      },
      'body',
    );
  return {
    async list(query: ListMeetings, userId: string) {
      if ('view' in query) {
        const rows = await repo.list(query, userId, 501);
        if (rows.length > 500)
          throw new AppError('VALIDATION_ERROR', undefined, [
            {
              path: 'query.to',
              message: 'Range contains more than 500 meetings; choose a smaller range',
            },
          ]);
        return { items: rows.map((row) => toMeeting(row, userId)) };
      }
      const rows = await repo.list(
        query,
        userId,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      );
      return {
        items: rows.map((row) => toMeeting(row, userId)),
        page: query.page,
        pageSize: query.pageSize,
        total: await repo.total(query, userId),
      };
    },
    async get(id: string, userId: string) {
      return {
        ...toMeeting(await requireMeeting(id), userId),
        feedback: (await repo.feedback(id)).map(toFeedback),
      };
    },
    async create(input: CreateMeeting, userId: string) {
      validateState(input);
      return deps.db.$transaction(async (tx) => {
        const transactional = meetingRepository(tx);
        const { candidate, interviewerIds = [], ...values } = input;
        await validateInterviewers(transactional, interviewerIds);
        let candidateId = input.candidateId;
        if (candidateId && !(await transactional.candidate(candidateId)))
          throw new AppError('NOT_FOUND');
        if (candidate)
          candidateId = (
            await transactional.insertCandidate({
              ...candidate,
              createdBy: userId,
              createdAt: deps.now(),
            })
          ).id;
        const now = deps.now();
        const created = await transactional.insert({
          ...values,
          candidateId,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
        await transactional.replaceInterviewers(created.id, interviewerIds, now);
        return toMeeting((await transactional.find(created.id))!, userId);
      });
    },
    async patch(id: string, input: PatchMeeting, user: AuthUser) {
      const current = await requireMeeting(id);
      requireManage(current, user);
      if (user.role === 'INTERVIEWER' && input.interviewerIds !== undefined)
        throw new AppError('FORBIDDEN');
      const { meeting } = current;
      checkVersion(meeting.version, input.version);
      const { version, candidate, interviewerIds, ...changes } = input;
      if (meeting.status === 'CANCELLED' && changes.status === 'CONFIRMED')
        throw new AppError('INVALID_TRANSITION');
      validateState({ ...meeting, ...changes });
      return deps.db.$transaction(async (tx) => {
        const transactional = meetingRepository(tx);
        if (interviewerIds !== undefined) await validateInterviewers(transactional, interviewerIds);
        if (changes.candidateId && !(await transactional.candidate(changes.candidateId)))
          throw new AppError('NOT_FOUND');
        const candidateId = candidate
          ? (
              await transactional.insertCandidate({
                ...candidate,
                createdBy: user.id,
                createdAt: deps.now(),
              })
            ).id
          : changes.candidateId;
        const updated = await transactional.update(id, version, {
          ...changes,
          ...(candidateId !== undefined ? { candidateId } : {}),
          updatedAt: deps.now(),
        });
        if (!updated) return stale(id);
        if (interviewerIds !== undefined)
          await transactional.replaceInterviewers(id, interviewerIds, deps.now());
        return toMeeting((await transactional.find(id))!, user.id);
      });
    },
    async cancel(id: string, version: number, user: AuthUser) {
      const current = await requireMeeting(id);
      requireManage(current, user);
      const { meeting } = current;
      checkVersion(meeting.version, version);
      if (meeting.status === 'CANCELLED') throw new AppError('INVALID_TRANSITION');
      return deps.db.$transaction(async (tx) => {
        const transactional = meetingRepository(tx);
        const updated = await transactional.update(id, version, {
          status: 'CANCELLED',
          updatedAt: deps.now(),
        });
        if (!updated) return stale(id);
        return toMeeting((await transactional.find(id))!, user.id);
      });
    },
    /** Recruiters cover each other's meetings but delete only their own; admins delete any (ADR-015). */
    async remove(id: string, version: number, user: AuthUser) {
      if (user.role === 'INTERVIEWER') throw new AppError('FORBIDDEN');
      if (user.role !== 'ADMIN') {
        const meeting = await requireMeeting(id);
        if (meeting.meeting.createdBy !== user.id) throw new AppError('FORBIDDEN');
      }
      if (!(await repo.remove(id, version))) await stale(id);
    },
  };
}
