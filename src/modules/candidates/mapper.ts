import type { Candidate } from '../../generated/prisma/client.js';

export function toCandidate(row: Candidate) {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}
