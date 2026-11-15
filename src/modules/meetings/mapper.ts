import type { feedback } from '../../db/schema/feedback.js';
import type { MeetingRow } from './repository.js';

export function toMeeting({ meeting: m, candidate: c }: MeetingRow, userId: string) {
  return {
    id: m.id, title: m.title, description: m.description, dueDate: m.dueDate.toISOString(),
    endAt: m.endAt?.toISOString() ?? null, status: m.status, meetingType: m.meetingType, provider: m.provider,
    candidate: c ? { id: c.id, name: c.name, position: c.position, createdAt: c.createdAt.toISOString() } : null,
    createdById: m.createdBy, isMine: m.createdBy === userId, version: m.version,
    createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
  };
}

export function toFeedback(row: typeof feedback.$inferSelect) {
  return { id: row.id, meetingId: row.meetingId, body: row.body, createdById: row.createdBy,
    createdAt: row.createdAt.toISOString() };
}
