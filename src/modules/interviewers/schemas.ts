import { z } from 'zod';
export const searchQuery = z.object({ query: z.string().trim().max(254).default('') }).strict();
