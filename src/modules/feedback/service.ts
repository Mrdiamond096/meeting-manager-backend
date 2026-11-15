import { AppError } from '../../http/errors.js';
import type { ModuleDeps } from '../deps.js';
import { feedbackRepository } from './repository.js';

export function feedbackService(deps: ModuleDeps) {
  return {
    append: (meetingId: string, body: string, userId: string) => deps.db.$transaction(async (tx) => {
      const repo = feedbackRepository(tx);
      if (!(await repo.lockMeeting(meetingId))) throw new AppError('NOT_FOUND');
      const row = await repo.create({ meetingId, body, createdBy: userId, createdAt: deps.now() });
      return { id: row.id, meetingId: row.meetingId, body: row.body,
        createdById: row.createdBy, createdAt: row.createdAt.toISOString() };
    }),
  };
}
