import { z } from 'zod';
import { CANDIDATE_POSITIONS } from '../../db/constants.js';

export const emptyQuery = z.object({}).strict();
export const searchQuery = z.object({ q: z.string().trim().min(1).max(120) }).strict();
export const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  position: z.string().trim().pipe(z.enum(CANDIDATE_POSITIONS)),
}).strict();
export type CreateCandidate = z.output<typeof createSchema>;
