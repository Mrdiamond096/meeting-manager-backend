import type { candidates } from '../../db/schema/index.js';

export function toCandidate(row: typeof candidates.$inferSelect) {
  return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt.toISOString() };
}
