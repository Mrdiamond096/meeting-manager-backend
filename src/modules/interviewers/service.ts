import type { ModuleDeps } from '../deps.js';
import { interviewerRepository } from './repository.js';
export const interviewerService = ({ db }: ModuleDeps) => ({
  search: async (query: string) => ({ items: await interviewerRepository(db).search(query) }),
});
