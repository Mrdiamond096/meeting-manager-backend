import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CANDIDATE_POSITIONS } from '../../src/db/constants.js';
import { seedDemoData } from '../../src/db/seed.js';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/modules/auth/authenticate.js';
import { createPasswordHasher } from '../../src/modules/auth/password.js';
import { createAuthApp, createClock, OTP, api } from '../auth/helpers.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password-123';
const DAY = 24 * 60 * 60 * 1000;
// Mid-afternoon in Bangkok, so "today" in Bangkok is the same calendar day as in UTC for the checks below.
const NOW = new Date('2026-11-16T08:00:00.000Z');

describe('seedDemoData', () => {
  const hasher = createPasswordHasher(4);
  let passwordHash: string;
  const run = () => seedDemoData(testDb, { email: EMAIL, passwordHash, now: NOW });

  beforeEach(async () => {
    await resetDb();
    passwordHash ??= await hasher.hash(PASSWORD);
  });

  it('creates a verified demo user with candidates, meetings and feedback', async () => {
    const result = await run();

    const user = await testDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.role).toBe('USER');
    expect(await testDb.candidate.count()).toBe(result.candidates);
    expect(await testDb.meeting.count()).toBe(result.meetings);
    expect(await testDb.feedback.count()).toBe(result.feedback);
    expect(result.feedback).toBeGreaterThan(0);
  });

  it('only creates data the API itself would accept', async () => {
    await run();

    for (const candidate of await testDb.candidate.findMany()) {
      expect(CANDIDATE_POSITIONS).toContain(candidate.position);
      expect(candidate.name).toBe(candidate.name.trim());
    }
    for (const m of await testDb.meeting.findMany({ include: { feedback: true } })) {
      expect(m.endAt!.getTime()).toBeGreaterThan(m.dueDate.getTime());
      expect(m.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      if (m.provider) expect(m.meetingType).toBe('ONLINE');
      if (m.status === 'CANCELLED') expect(m.feedback).toEqual([]);
      for (const f of m.feedback)
        expect(f.createdAt.getTime()).toBeGreaterThan(m.dueDate.getTime());
    }
  });

  it('spreads meetings around today with every status, a generic meeting and a meeting today', async () => {
    await run();
    const meetings = await testDb.meeting.findMany();

    const days = meetings.map((m) =>
      Math.floor((m.dueDate.getTime() - Date.parse('2026-11-15T17:00:00.000Z')) / DAY),
    );
    expect(Math.min(...days)).toBeLessThan(-3);
    expect(Math.max(...days)).toBeGreaterThan(7);
    expect(days.filter((d) => d === 0).length).toBeGreaterThan(0); // today (Bangkok)
    expect(new Set(meetings.map((m) => m.status))).toEqual(
      new Set(['PENDING', 'CONFIRMED', 'CANCELLED']),
    );
    expect(meetings.some((m) => m.candidateId === null)).toBe(true);
    expect(meetings.some((m) => m.meetingType === 'ONSITE')).toBe(true);
    expect(meetings.some((m) => m.provider === 'GOOGLE_MEET')).toBe(true);
  });

  it('moves with the clock: a later run puts the same meetings around the new today', async () => {
    await run();
    const first = (await testDb.meeting.findMany()).map((m) => m.dueDate.getTime()).sort();

    await seedDemoData(testDb, {
      email: EMAIL,
      passwordHash,
      now: new Date(NOW.getTime() + 10 * DAY),
    });
    const second = (await testDb.meeting.findMany()).map((m) => m.dueDate.getTime()).sort();

    expect(second).toEqual(first.map((t) => t + 10 * DAY));
  });

  it('can be run again: same rows, no duplicates, the user is kept', async () => {
    const first = await run();
    const firstId = (await testDb.user.findUniqueOrThrow({ where: { email: EMAIL } })).id;
    await run();

    expect(await testDb.user.count()).toBe(1);
    expect((await testDb.user.findUniqueOrThrow({ where: { email: EMAIL } })).id).toBe(firstId);
    expect(await testDb.candidate.count()).toBe(first.candidates);
    expect(await testDb.meeting.count()).toBe(first.meetings);
    expect(await testDb.feedback.count()).toBe(first.feedback);
  });

  it('resets the demo account: edits are undone, password restored, sessions and challenges dropped', async () => {
    await run();
    const user = await testDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await testDb.meeting.updateMany({
      where: { createdBy: user.id },
      data: { title: 'vandalised' },
    });
    await testDb.candidate.create({
      data: { name: 'Spam', position: 'QA Engineer', createdBy: user.id },
    });
    await testDb.user.update({
      where: { id: user.id },
      data: { passwordHash: 'changed', emailVerifiedAt: null },
    });
    await testDb.session.create({
      data: {
        tokenHash: 'a'.repeat(64),
        userId: user.id,
        expiresAt: new Date(NOW.getTime() + DAY),
      },
    });
    await testDb.otpChallenge.create({
      data: {
        userId: user.id,
        purpose: 'LOGIN',
        codeHash: 'x',
        expiresAt: new Date(NOW.getTime() + DAY),
      },
    });

    await run();

    expect(await testDb.meeting.count({ where: { title: 'vandalised' } })).toBe(0);
    expect(await testDb.candidate.count({ where: { name: 'Spam' } })).toBe(0);
    const after = await testDb.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(after.passwordHash).toBe(passwordHash);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await testDb.session.count()).toBe(0);
    expect(await testDb.otpChallenge.count()).toBe(0);
  });

  it('leaves other users and their data alone', async () => {
    const other = await createUser();
    const theirCandidate = await testDb.candidate.create({
      data: { name: 'Theirs', position: 'QA Engineer', createdBy: other.id },
    });
    await testDb.meeting.create({
      data: { title: 'Theirs', dueDate: NOW, createdBy: other.id, candidateId: theirCandidate.id },
    });

    await run();
    await run();

    expect(await testDb.user.count({ where: { id: other.id } })).toBe(1);
    expect(await testDb.meeting.count({ where: { title: 'Theirs' } })).toBe(1);
    expect(await testDb.candidate.count({ where: { name: 'Theirs' } })).toBe(1);
  });

  it('keeps a demo candidate that another user booked, instead of failing', async () => {
    await run();
    const someone = await createUser();
    const demoCandidate = (
      await testDb.candidate.findMany({ where: { name: 'Somchai Jaidee' } })
    )[0]!;
    await testDb.meeting.create({
      data: {
        title: 'Booked by someone else',
        dueDate: NOW,
        createdBy: someone.id,
        candidateId: demoCandidate.id,
      },
    });

    await expect(run()).resolves.toBeDefined();

    expect(await testDb.meeting.count({ where: { title: 'Booked by someone else' } })).toBe(1);
    expect(await testDb.candidate.count({ where: { id: demoCandidate.id } })).toBe(1);
  });

  it('gives a user who can sign in through the real flow and see the meetings', async () => {
    await run();
    const clock = createClock(NOW);
    const app = createAuthApp({ now: clock.now, passwordHasher: hasher });

    const login = await api(app).login({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const verified = await api(app).verify({ challengeId: login.body.challengeId, code: OTP });
    expect(verified.status).toBe(200);
    expect(verified.body.user.email).toBe(EMAIL);

    const full = createApp({
      pingDb: async () => {},
      db: testDb,
      now: clock.now,
      authenticate: createAuthenticate({ db: testDb, now: clock.now }),
      appVersion: 'test',
    });
    const cookie = (verified.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const list = await request(full).get('/api/v1/meetings?pageSize=50').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(14);
    const detail = await request(full)
      .get(`/api/v1/meetings/${list.body.items[0].id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
  });
});
