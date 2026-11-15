import { AppError } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import type { ModuleDeps } from '../deps.js';
import { toFeedback, toMeeting } from './mapper.js';
import { meetingRepository } from './repository.js';
import { meetingState, type CreateMeeting, type ListMeetings, type PatchMeeting } from './schemas.js';

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
  const written = async (meeting: NonNullable<Awaited<ReturnType<typeof repo.update>>>, userId: string) =>
    toMeeting({ meeting, candidate: meeting.candidateId ? await repo.candidate(meeting.candidateId) ?? null : null }, userId);
  const validateState = (m: { dueDate: Date; endAt?: Date | null; meetingType?: string | null; provider?: string | null }) =>
    parse(meetingState, { dueDate: m.dueDate, endAt: m.endAt ?? null,
      meetingType: m.meetingType ?? null, provider: m.provider ?? null }, 'body');
  return {
    async list(query: ListMeetings, userId: string) {
      if ('view' in query) {
        const rows = await repo.list(query, userId, 501);
        if (rows.length > 500) throw new AppError('VALIDATION_ERROR', undefined,
          [{ path: 'query.to', message: 'Range contains more than 500 meetings; choose a smaller range' }]);
        return { items: rows.map((row) => toMeeting(row, userId)) };
      }
      const rows = await repo.list(query, userId, query.pageSize, (query.page - 1) * query.pageSize);
      return { items: rows.map((row) => toMeeting(row, userId)), page: query.page,
        pageSize: query.pageSize, total: await repo.total(query, userId) };
    },
    async get(id: string, userId: string) {
      return { ...toMeeting(await requireMeeting(id), userId), feedback: (await repo.feedback(id)).map(toFeedback) };
    },
    async create(input: CreateMeeting, userId: string) {
      validateState(input);
      return deps.db.transaction(async (tx) => {
        const transactional = meetingRepository(tx);
        const { candidate, ...values } = input;
        let candidateId = input.candidateId;
        if (candidateId && !(await transactional.candidate(candidateId))) throw new AppError('NOT_FOUND');
        if (candidate) candidateId = (await transactional.insertCandidate({ ...candidate, createdBy: userId,
          createdAt: deps.now() })).id;
        const now = deps.now();
        const created = await transactional.insert({ ...values, candidateId, createdBy: userId,
          createdAt: now, updatedAt: now });
        return toMeeting((await transactional.find(created.id))!, userId);
      });
    },
    async patch(id: string, input: PatchMeeting, userId: string) {
      const { meeting } = await requireMeeting(id);
      checkVersion(meeting.version, input.version);
      const { version, ...changes } = input;
      if (meeting.status === 'CANCELLED' && changes.status === 'CONFIRMED') throw new AppError('INVALID_TRANSITION');
      validateState({ ...meeting, ...changes });
      if (changes.candidateId && !(await repo.candidate(changes.candidateId))) throw new AppError('NOT_FOUND');
      const updated = await repo.update(id, version, { ...changes, updatedAt: deps.now() });
      return updated ? written(updated, userId) : stale(id);
    },
    async cancel(id: string, version: number, userId: string) {
      const { meeting } = await requireMeeting(id);
      checkVersion(meeting.version, version);
      if (meeting.status === 'CANCELLED') throw new AppError('INVALID_TRANSITION');
      const updated = await repo.update(id, version, { status: 'CANCELLED', updatedAt: deps.now() });
      return updated ? written(updated, userId) : stale(id);
    },
    async remove(id: string, version: number) {
      if (!(await repo.remove(id, version))) await stale(id);
    },
  };
}
