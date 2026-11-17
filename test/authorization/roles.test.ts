import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/http/auth-guard.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';
import { loginAs } from '../helpers/app.js';
import { api, createAuthApp, createClock, PASSWORD } from '../auth/helpers.js';

const now = () => new Date('2026-11-15T09:00:00.000Z');
const meetingBody = { title: 'Interview', dueDate: '2026-11-20T03:00:00.000Z' };
const seedMeeting = (createdBy?: string) =>
  testDb.meeting.create({ data: { title: 'Interview', dueDate: now(), createdBy } });
const as = (role: AuthUser['role']) => loginAs({ now, role });

describe('registration roles (ADR-015)', () => {
  const app = createAuthApp({ now: createClock().now, adminEmails: ['boss@example.test'] });
  beforeEach(resetDb);

  it('defaults to RECRUITER and stores a chosen INTERVIEWER role', async () => {
    await api(app).register({ email: 'r@example.test', password: PASSWORD });
    await api(app).register({ email: 'i@example.test', password: PASSWORD, role: 'INTERVIEWER' });
    const roles = Object.fromEntries((await testDb.user.findMany()).map((u) => [u.email, u.role]));
    expect(roles).toEqual({ 'r@example.test': 'RECRUITER', 'i@example.test': 'INTERVIEWER' });
  });

  it('makes an ADMIN_EMAILS address an ADMIN whatever role it asked for', async () => {
    await api(app).register({
      email: 'Boss@Example.test',
      password: PASSWORD,
      role: 'INTERVIEWER',
    });
    expect((await testDb.user.findFirstOrThrow()).role).toBe('ADMIN');
  });

  it('applies the latest role when an unverified account registers again', async () => {
    await api(app).register({ email: 'x@example.test', password: PASSWORD });
    await api(app).register({ email: 'x@example.test', password: PASSWORD, role: 'INTERVIEWER' });
    expect((await testDb.user.findFirstOrThrow()).role).toBe('INTERVIEWER');
  });
});

describe('meeting permissions by role (ADR-015)', () => {
  beforeEach(resetDb);

  it('lets an interviewer read meetings and add feedback, but not schedule or change them', async () => {
    const { app } = await as('INTERVIEWER');
    const meeting = await seedMeeting();
    const url = `/api/v1/meetings/${meeting.id}`;
    expect((await request(app).get('/api/v1/meetings')).status).toBe(200);
    expect((await request(app).get(url)).status).toBe(200);
    expect((await request(app).post(`${url}/feedback`).send({ body: 'Strong' })).status).toBe(201);

    const denied = [
      await request(app).post('/api/v1/meetings').send(meetingBody),
      await request(app).patch(url).send({ version: 1, title: 'X' }),
      await request(app).post(`${url}/cancel`).send({ version: 1 }),
      await request(app).delete(`${url}?version=1`),
      await request(app).post('/api/v1/candidates').send({ name: 'A', position: 'QA Engineer' }),
    ];
    expect(denied.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(denied[0]!.body.error.code).toBe('FORBIDDEN');
    expect((await testDb.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).version).toBe(1);
  });

  it("lets a recruiter edit and cancel a colleague's meeting but delete only their own", async () => {
    const colleague = await createUser({ role: 'RECRUITER' });
    const { app, user } = await as('RECRUITER');
    const theirs = await seedMeeting(colleague.id);
    const mine = await seedMeeting(user.id);

    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${theirs.id}`)
          .send({ version: 1, title: 'Moved' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/v1/meetings/${theirs.id}/cancel`).send({ version: 2 })).status,
    ).toBe(200);
    const forbidden = await request(app).delete(`/api/v1/meetings/${theirs.id}?version=3`);
    expect(forbidden.status).toBe(403);
    expect(await testDb.meeting.count({ where: { id: theirs.id } })).toBe(1);
    expect((await request(app).delete(`/api/v1/meetings/${mine.id}?version=1`)).status).toBe(204);
  });

  it("lets an admin delete anyone's meeting", async () => {
    const colleague = await createUser({ role: 'RECRUITER' });
    const { app } = await as('ADMIN');
    const theirs = await seedMeeting(colleague.id);
    expect((await request(app).delete(`/api/v1/meetings/${theirs.id}?version=1`)).status).toBe(204);
  });

  it('still answers 404 to a recruiter deleting a meeting that does not exist', async () => {
    const { app } = await as('RECRUITER');
    const res = await request(app).delete(
      '/api/v1/meetings/00000000-0000-4000-8000-000000000000?version=1',
    );
    expect(res.status).toBe(404);
  });
});
