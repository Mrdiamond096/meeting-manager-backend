import { z } from 'zod';
export const searchBody = z.object({ query: z.string().trim().max(254).default('') }).strict();
