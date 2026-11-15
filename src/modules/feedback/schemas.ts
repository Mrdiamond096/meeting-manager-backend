import { z } from 'zod';

export const emptyQuery = z.object({}).strict();
export const createSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
