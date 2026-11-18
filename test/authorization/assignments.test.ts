import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/http/auth-guard.js';
import { createTestApp, loginAs, loginViaApi } from '../helpers/app.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const now = () => new Date('2026-11-18T03:00:00.000Z');
const body = { title: 'Panel interview', dueDate: '2026-11-20T03:00:00.000Z' };
const asUser = (user: { id: string; role: string }) =>
  createTestApp({ now, user: { id: user.id, role: user.role as AuthUser['role'] } });
const seed = (creator: string, ids: string[] = [], candidateId?: string) =>
  testDb.meeting.create({
    data: {
      ...body,
      dueDate: new Date(body.dueDate),
      createdBy: creator,
      candidateId,
      interviewers: { create: ids.map((userId) => ({ userId, assignedAt: now() })) },
    },
  });

beforeEach(resetDb);

describe('multi-interviewer assignments', () => {
  it('lets a recruiter assign multiple verified interviewers without changing creator ownership', async () => {
    const { app, user } = await loginAs({ now });
    const a = await createUser({ role: 'INTERVIEWER' });
    const b = await createUser({ role: 'INTERVIEWER' });
    const response = await request(app)
      .post('/api/v1/meetings')
      .send({ ...body, interviewerIds: [b.id, a.id] });
    expect(response.status).toBe(201);
    expect(response.body.createdById).toBe(user.id);
    expect(response.body.isMine).toBe(true);
    expect(new Set(response.body.interviewers.map((p: { id: string }) => p.id))).toEqual(
      new Set([a.id, b.id]),
    );
    expect(
      response.body.interviewers.every(
        (p: object) => Object.keys(p).sort().join(',') === 'email,id',
      ),
    ).toBe(true);
    expect((await request(asUser(a)).get(`/api/v1/meetings/${response.body.id}`)).body.isMine).toBe(
      false,
    );
  });

  it('allows both assigned interviewers to edit/cancel, but never delete, create or change assignments', async () => {
    const owner = await createUser();
    const a = await createUser({ role: 'INTERVIEWER' });
    const b = await createUser({ role: 'INTERVIEWER' });
    const meeting = await seed(owner.id, [a.id, b.id]);
    const appA = asUser(a),
      appB = asUser(b);
    expect(
      (
        await request(appA)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 1, title: 'Updated panel' })
      ).status,
    ).toBe(200);
    expect(
      (await request(appB).post(`/api/v1/meetings/${meeting.id}/cancel`).send({ version: 2 }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(appA)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 3, interviewerIds: [] })
      ).status,
    ).toBe(403);
    expect((await request(appA).delete(`/api/v1/meetings/${meeting.id}?version=3`)).status).toBe(
      403,
    );
    expect((await request(appA).post('/api/v1/meetings').send(body)).status).toBe(403);
    expect(await testDb.meetingInterviewer.count({ where: { meetingId: meeting.id } })).toBe(2);
  });

  it('denies unassigned edits before any inline candidate is inserted; feedback remains team-wide', async () => {
    const owner = await createUser();
    const unassigned = await createUser({ role: 'INTERVIEWER' });
    const meeting = await seed(owner.id);
    const app = asUser(unassigned);
    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 1, candidate: { name: 'Forbidden insert', position: 'QA Engineer' } })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post(`/api/v1/meetings/${meeting.id}/cancel`).send({ version: 1 }))
        .status,
    ).toBe(403);
    expect((await request(app).get(`/api/v1/meetings/${meeting.id}`)).status).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/v1/meetings/${meeting.id}/feedback`)
          .send({ body: 'Feedback from a colleague' })
      ).status,
    ).toBe(201);
    expect(await testDb.candidate.count()).toBe(0);
    expect((await testDb.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).version).toBe(1);
    // Creator audit data alone never grants an interviewer edit permission.
    const legacy = await seed(unassigned.id);
    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${legacy.id}`)
          .send({ version: 1, title: 'Creator is not assignee' })
      ).status,
    ).toBe(403);
  });

  it('removes old assignee access after reassignment while preserving other meeting fields', async () => {
    const { app, user } = await loginAs({ now });
    const a = await createUser({ role: 'INTERVIEWER' }),
      b = await createUser({ role: 'INTERVIEWER' });
    const meeting = await seed(user.id, [a.id]);
    const changed = await request(app)
      .patch(`/api/v1/meetings/${meeting.id}`)
      .send({ version: 1, interviewerIds: [b.id] });
    expect(changed.status).toBe(200);
    expect(changed.body.version).toBe(2);
    expect(changed.body.interviewers.map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect(
      (
        await request(asUser(a))
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 1, title: 'Stale author' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(asUser(b))
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 2, title: 'New assignee' })
      ).status,
    ).toBe(200);
    const cleared = await request(app)
      .patch(`/api/v1/meetings/${meeting.id}`)
      .send({ version: 3, interviewerIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.interviewers).toEqual([]);
    expect(
      (await request(asUser(b)).post(`/api/v1/meetings/${meeting.id}/cancel`).send({ version: 4 }))
        .status,
    ).toBe(403);
  });

  it('rejects invalid assignment lists and rolls back all fields and inline candidates', async () => {
    const { app, user } = await loginAs({ now });
    const a = await createUser({ role: 'INTERVIEWER' });
    const unverified = await createUser({ role: 'INTERVIEWER', emailVerifiedAt: null });
    const meeting = await seed(user.id, [a.id]);
    for (const ids of [
      [user.id],
      [unverified.id],
      [crypto.randomUUID()],
      [a.id, a.id],
      Array.from({ length: 51 }, () => crypto.randomUUID()),
    ]) {
      const response = await request(app)
        .patch(`/api/v1/meetings/${meeting.id}`)
        .send({
          version: 1,
          title: 'Must not persist',
          interviewerIds: ids,
          candidate: { name: 'Must roll back', position: 'QA Engineer' },
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await testDb.candidate.count()).toBe(0);
    const unchanged = await request(app).get(`/api/v1/meetings/${meeting.id}`);
    expect(unchanged.body.title).toBe(body.title);
    expect(unchanged.body.version).toBe(1);
    expect(unchanged.body.interviewers.map((p: { id: string }) => p.id)).toEqual([a.id]);
  });

  it('keeps panel changes and inline candidates atomic under a stale version', async () => {
    const { app, user } = await loginAs({ now });
    const a = await createUser({ role: 'INTERVIEWER' }),
      b = await createUser({ role: 'INTERVIEWER' });
    const meeting = await seed(user.id, [a.id]);
    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .send({ version: 1, interviewerIds: [b.id] })
      ).status,
    ).toBe(200);
    const stale = await request(app)
      .patch(`/api/v1/meetings/${meeting.id}`)
      .send({
        version: 1,
        interviewerIds: [a.id],
        candidate: { name: 'Stale candidate', position: 'QA Engineer' },
      });
    expect(stale.status).toBe(409);
    expect(await testDb.candidate.count()).toBe(0);
    expect((await testDb.meetingInterviewer.findMany()).map((p) => p.userId)).toEqual([b.id]);
  });

  it('filters assigned meetings separately from creator mine in list/range and includes assignments in candidate summaries', async () => {
    const owner = await createUser(),
      a = await createUser({ role: 'INTERVIEWER' });
    const candidate = await testDb.candidate.create({
      data: { name: 'Panel candidate', position: 'QA Engineer' },
    });
    const assigned = await seed(owner.id, [a.id], candidate.id);
    await seed(owner.id);
    const app = asUser(a);
    expect(
      (await request(app).get('/api/v1/meetings').query({ assignedToMe: true })).body.items.map(
        (m: { id: string }) => m.id,
      ),
    ).toEqual([assigned.id]);
    expect((await request(app).get('/api/v1/meetings').query({ mine: true })).body.items).toEqual(
      [],
    );
    expect(
      (await request(app).get('/api/v1/meetings').query({ assignedToMe: true, mine: true })).body
        .items,
    ).toEqual([]);
    const range = await request(app).get('/api/v1/meetings').query({
      view: 'range',
      from: '2026-11-19T00:00:00Z',
      to: '2026-11-21T00:00:00Z',
      assignedToMe: true,
    });
    expect(range.body.items.map((m: { id: string }) => m.id)).toEqual([assigned.id]);
    const summary = await request(app).get(`/api/v1/candidates/${candidate.id}`);
    expect(summary.body.upcoming[0].interviewers).toEqual([{ id: a.id, email: a.email }]);
  });

  it('enforces assignments using a real session and current database role', async () => {
    const { app, user, cookie } = await loginViaApi({ now });
    await testDb.user.update({ where: { id: user.id }, data: { role: 'INTERVIEWER' } });
    const owner = await createUser();
    const meeting = await seed(owner.id, [user.id]);
    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .set('Cookie', cookie)
          .send({ version: 1, description: 'From an authenticated assignee' })
      ).status,
    ).toBe(200);
    await testDb.meetingInterviewer.deleteMany({ where: { meetingId: meeting.id } });
    expect(
      (
        await request(app)
          .patch(`/api/v1/meetings/${meeting.id}`)
          .set('Cookie', cookie)
          .send({ version: 2, title: 'Now unassigned' })
      ).status,
    ).toBe(403);
  });
});

describe('interviewer directory', () => {
  it('returns only verified interviewer id/email, supports literal email search and denies interviewer access', async () => {
    const { app } = await loginAs({ now });
    const a = await createUser({ role: 'INTERVIEWER', email: 'person%tag@example.test' });
    await createUser({ role: 'INTERVIEWER', email: 'other@example.test' });
    await createUser({ role: 'INTERVIEWER', emailVerifiedAt: null });
    const response = await request(app).get('/api/v1/interviewers');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(
      response.body.items.every((p: object) => Object.keys(p).sort().join(',') === 'email,id'),
    ).toBe(true);
    expect(
      (await request(app).get('/api/v1/interviewers').query({ query: '%' })).body.items,
    ).toEqual([{ id: a.id, email: a.email }]);
    expect((await request(asUser(a)).get('/api/v1/interviewers')).status).toBe(403);
    expect((await request(app).get('/api/v1/interviewers').query({ extra: 'x' })).status).toBe(400);
  });
});
