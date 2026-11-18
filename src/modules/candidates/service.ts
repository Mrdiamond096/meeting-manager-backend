import { AppError } from '../../http/errors.js';
import type { ModuleDeps } from '../deps.js';
import { toMeetingRow } from '../meetings/repository.js';
import { toMeeting } from '../meetings/mapper.js';
import { toCandidate } from './mapper.js';
import { candidateRepository } from './repository.js';
import type { CreateCandidate } from './schemas.js';

export function candidateService(deps: ModuleDeps) {
  const repo = candidateRepository(deps.db);
  return {
    search: async (query: string) => ({ items: (await repo.search(query)).map(toCandidate) }),
    create: async (input: CreateCandidate, userId: string) =>
      toCandidate(await repo.create({ ...input, createdBy: userId, createdAt: deps.now() })),
    async get(id: string, userId: string) {
      const candidate = await repo.find(id);
      if (!candidate) throw new AppError('NOT_FOUND');
      const now = deps.now();
      const upcoming = await repo.upcoming(id, now);
      const history = await repo.history(id, now);
      return {
        candidate: toCandidate(candidate),
        upcoming: upcoming.map((meeting) => toMeeting(toMeetingRow(meeting), userId)),
        history: history.map((meeting) => toMeeting(toMeetingRow(meeting), userId)),
      };
    },
  };
}
