import type { Feedback } from '../../generated/prisma/client.js';

export function toFeedback(row: Feedback) {
  return {
    id: row.id,
    meetingId: row.meetingId,
    body: row.body,
    createdById: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
