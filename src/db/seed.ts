import type { Database } from './client.js';
import type { CANDIDATE_POSITIONS, MEETING_PROVIDERS, MEETING_TYPES } from './constants.js';

/**
 * Demo data for `make seed`: one verified user, a few candidates and meetings around today.
 *
 * Re-running it resets what a previous run created. It only touches rows the demo user created (plus that user
 * itself), so accounts and meetings of anyone else are left alone. Dates are relative to `now`, so the calendar
 * always has something this week.
 */

type Position = (typeof CANDIDATE_POSITIONS)[number];
type MeetingType = (typeof MEETING_TYPES)[number];
type Provider = (typeof MEETING_PROVIDERS)[number];

const CANDIDATES: { key: string; name: string; position: Position }[] = [
  { key: 'somchai', name: 'Somchai Jaidee', position: 'Backend Engineer' },
  { key: 'napat', name: 'Napat Srisuk', position: 'Frontend Engineer' },
  { key: 'alice', name: 'Alice Johnson', position: 'Full Stack Engineer' },
  { key: 'pimchanok', name: 'Pimchanok Wongsa', position: 'QA Engineer' },
  { key: 'arun', name: 'Arun Kittipong', position: 'Data Engineer' },
  { key: 'mali', name: 'Mali Chaiyasit', position: 'Product Designer' },
  { key: 'david', name: 'David Chen', position: 'DevOps Engineer' },
  { key: 'kanya', name: 'Kanya Rattana', position: 'Product Manager' },
];

interface MeetingTemplate {
  title: string;
  /** Days from today (negative = past). */
  day: number;
  /** Start hour in Bangkok time (UTC+7), the zone the demo is shown in. */
  hour: number;
  minutes: number;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
  candidate?: string;
  type?: MeetingType;
  provider?: Provider;
  description?: string;
  feedback?: string[];
}

const MEETINGS: MeetingTemplate[] = [
  {
    title: 'Technical interview: Somchai Jaidee', day: -9, hour: 10, minutes: 60, status: 'CONFIRMED',
    candidate: 'somchai', type: 'ONLINE', provider: 'GOOGLE_MEET', description: 'System design and API questions.',
    feedback: ['Strong on API design and PostgreSQL. Could explain trade-offs more.', 'Recommend moving to the final round.'],
  },
  {
    title: 'Portfolio review: Mali Chaiyasit', day: -6, hour: 14, minutes: 45, status: 'CONFIRMED',
    candidate: 'mali', type: 'ONSITE', description: 'Walkthrough of two case studies.',
    feedback: ['Clear process and good accessibility awareness.'],
  },
  {
    title: 'Screening call: David Chen', day: -4, hour: 11, minutes: 30, status: 'CANCELLED',
    candidate: 'david', type: 'ONLINE', provider: 'ZOOM', description: 'Cancelled: the candidate accepted another offer.',
  },
  {
    title: 'Coding exercise: Napat Srisuk', day: -2, hour: 15, minutes: 90, status: 'CONFIRMED',
    candidate: 'napat', type: 'ONLINE', provider: 'ZOOM',
    feedback: ['Clean React code, good tests. Slow start on the data-fetching part.'],
  },
  { title: 'Team sync: hiring pipeline', day: 0, hour: 9, minutes: 30, status: 'CONFIRMED', type: 'ONSITE' },
  {
    title: 'Technical interview: Alice Johnson', day: 0, hour: 14, minutes: 60, status: 'CONFIRMED',
    candidate: 'alice', type: 'ONLINE', provider: 'GOOGLE_MEET', description: 'Full stack pairing session.',
  },
  {
    title: 'First call: Pimchanok Wongsa', day: 1, hour: 10, minutes: 30, status: 'PENDING',
    candidate: 'pimchanok', type: 'ONLINE', provider: 'ZOOM',
  },
  {
    title: 'Data pipeline case study: Arun Kittipong', day: 2, hour: 13, minutes: 60, status: 'CONFIRMED',
    candidate: 'arun', type: 'ONSITE', description: 'Bring a laptop; the case study is on paper.',
  },
  {
    title: 'Product sense interview: Kanya Rattana', day: 3, hour: 16, minutes: 60, status: 'PENDING',
    candidate: 'kanya', type: 'ONLINE', provider: 'OTHER',
  },
  {
    title: 'Final round: Somchai Jaidee', day: 5, hour: 11, minutes: 90, status: 'PENDING',
    candidate: 'somchai', type: 'ONSITE', description: 'Meet the engineering manager and the team.',
  },
  {
    title: 'Infrastructure interview: David Chen', day: 7, hour: 15, minutes: 60, status: 'PENDING',
    candidate: 'david', type: 'ONLINE', provider: 'ZOOM',
  },
  { title: 'Offer discussion: Alice Johnson', day: 9, hour: 10, minutes: 30, status: 'PENDING', candidate: 'alice' },
  {
    title: 'Design critique: Mali Chaiyasit', day: 12, hour: 14, minutes: 45, status: 'PENDING',
    candidate: 'mali', type: 'ONLINE', provider: 'GOOGLE_MEET',
  },
  { title: 'Interview day planning', day: 14, hour: 9, minutes: 60, status: 'PENDING', type: 'ONSITE' },
];

const BANGKOK_OFFSET_HOURS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Midnight at the start of `now`'s calendar day in Bangkok, as an instant. */
function startOfBangkokDay(now: Date): Date {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_HOURS * HOUR_MS);
  const midnightLocal = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnightLocal - BANGKOK_OFFSET_HOURS * HOUR_MS);
}

export interface SeedOptions {
  email: string;
  /** Already hashed with the same bcrypt cost as registration. */
  passwordHash: string;
  now: Date;
}

export interface SeedResult {
  userId: string;
  candidates: number;
  meetings: number;
  feedback: number;
}

export async function seedDemoData(db: Database, { email, passwordHash, now }: SeedOptions): Promise<SeedResult> {
  const today = startOfBangkokDay(now);

  return db.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email },
      create: { email, passwordHash, emailVerifiedAt: now, createdAt: now, updatedAt: now },
      update: { passwordHash, emailVerifiedAt: now, updatedAt: now },
    });

    // Reset: sign the demo user out and drop what an earlier run created. Meetings go first because they hold
    // the candidate (ON DELETE RESTRICT); a candidate someone else still uses is kept.
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.otpChallenge.deleteMany({ where: { userId: user.id } });
    await tx.meeting.deleteMany({ where: { createdBy: user.id } });
    await tx.candidate.deleteMany({ where: { createdBy: user.id, meetings: { none: {} } } });

    const candidateIds = new Map<string, string>();
    for (const [index, candidate] of CANDIDATES.entries()) {
      const created = await tx.candidate.create({
        data: {
          name: candidate.name,
          position: candidate.position,
          createdBy: user.id,
          // Spread over the last days so the creation order is visible and stable.
          createdAt: new Date(today.getTime() - (CANDIDATES.length - index) * DAY_MS + 9 * HOUR_MS),
        },
      });
      candidateIds.set(candidate.key, created.id);
    }

    let feedback = 0;
    for (const meeting of MEETINGS) {
      const dueDate = new Date(today.getTime() + meeting.day * DAY_MS + meeting.hour * HOUR_MS);
      const endAt = new Date(dueDate.getTime() + meeting.minutes * MINUTE_MS);
      // Created two days before the meeting, never in the future.
      const createdAt = new Date(Math.min(dueDate.getTime() - 2 * DAY_MS, now.getTime()));
      const created = await tx.meeting.create({
        data: {
          title: meeting.title,
          description: meeting.description ?? '',
          dueDate,
          endAt,
          status: meeting.status,
          meetingType: meeting.type ?? null,
          provider: meeting.provider ?? null,
          candidateId: meeting.candidate ? candidateIds.get(meeting.candidate) : null,
          createdBy: user.id,
          createdAt,
          updatedAt: createdAt,
        },
      });
      for (const [order, body] of (meeting.feedback ?? []).entries()) {
        await tx.feedback.create({
          data: {
            meetingId: created.id,
            body,
            createdBy: user.id,
            createdAt: new Date(endAt.getTime() + (order + 1) * 30 * MINUTE_MS),
          },
        });
        feedback += 1;
      }
    }

    return { userId: user.id, candidates: CANDIDATES.length, meetings: MEETINGS.length, feedback };
  });
}
