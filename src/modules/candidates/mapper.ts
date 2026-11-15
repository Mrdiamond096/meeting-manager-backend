import type { candidates, meetings } from '../../db/schema/index.js';

type Candidate = typeof candidates.$inferSelect;
export function toCandidate(row: Candidate) {
  return { id: row.id, name: row.name, position: row.position, createdAt: row.createdAt.toISOString() };
}

// This module builds independently of the unmerged A1 branch; expose only the frozen Meeting DTO.
export function toCandidateMeeting(row: typeof meetings.$inferSelect, candidate: Candidate, userId: string) {
  return {
    id: row.id, title: row.title, description: row.description, dueDate: row.dueDate.toISOString(),
    endAt: row.endAt?.toISOString() ?? null, status: row.status, meetingType: row.meetingType, provider: row.provider,
    candidate: toCandidate(candidate), createdById: row.createdBy, isMine: row.createdBy === userId,
    version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}
