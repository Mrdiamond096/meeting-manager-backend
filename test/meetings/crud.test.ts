import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { candidates, feedback, meetings } from '../../src/db/schema/index.js';
import { meetingService } from '../../src/modules/meetings/service.js';
import { createTestApp, loginAs } from '../helpers/app.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const root = '/api/v1/meetings';
const now = () => new Date('2026-11-15T09:00:00.000Z');
const input = { title: ' Interview ', dueDate: '2026-11-20T10:00:00+07:00' };

describe('meetings CRUD', () => {
  beforeEach(resetDb);

  it('creates a generic meeting with server-owned fields, UTC dates and a Location header', async () => {
    const { app, user } = await loginAs({ now });
    const res = await request(app).post(root).send(input);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`${root}/${res.body.id}`);
    expect(res.body).toEqual({
      id: expect.any(String), title: 'Interview', description: '', dueDate: '2026-11-20T03:00:00.000Z',
      endAt: null, status: 'PENDING', meetingType: null, provider: null, candidate: null,
      createdById: user.id, isMine: true, version: 1, createdAt: now().toISOString(), updatedAt: now().toISOString(),
    });
    const detail = await request(app).get(`${root}/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ ...res.body, feedback: [] });
    const persisted = await testDb.select().from(meetings).where(eq(meetings.id, res.body.id));
    expect(persisted[0]?.createdBy).toBe(user.id);
  });

  it.each([
    {}, { ...input, title: '   ' }, { ...input, title: 'x'.repeat(151) },
    { ...input, description: 'x'.repeat(5001) }, { ...input, description: null },
    { ...input, dueDate: '2026-11-20' }, { ...input, dueDate: '2026-11-20T10:00:00' },
    { ...input, dueDate: '2026-02-30T10:00:00Z' }, { ...input, status: 'CANCELLED' },
    { ...input, status: 'COMPLETED' }, { ...input, createdById: randomUUID() },
    { ...input, version: 2 }, { ...input, candidateId: 'invalid' },
    { ...input, endAt: '2026-11-20T03:00:00Z' }, { ...input, provider: 'ZOOM' },
    { ...input, meetingType: 'ONSITE', provider: 'ZOOM' },
    { ...input, candidate: { name: 'Alice', position: 'Unknown' } },
    { ...input, candidate: { name: 'Alice', position: 'Software Engineer', extra: true } },
    { ...input, candidate: { name: 'Alice', position: 'Software Engineer' }, candidateId: randomUUID() },
  ])('rejects invalid or undeclared creation fields: %j', async (body) => {
    const { app } = await loginAs();
    const res = await request(app).post(root).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.any(Array), requestId: expect.any(String) });
    expect(await testDb.select().from(meetings)).toEqual([]);
    expect(await testDb.select().from(candidates)).toEqual([]);
  });

  it('keeps duplicate titles and same-name candidates distinct; joins only by identity', async () => {
    const { app } = await loginAs();
    const candidate = { name: ' Alice ', position: 'Software Engineer' };
    const first = await request(app).post(root).send({ ...input, candidate });
    const second = await request(app).post(root).send({ ...input, candidate });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.candidate.name).toBe('Alice');
    expect(first.body.candidate.id).not.toBe(second.body.candidate.id);
    const existing = await request(app).post(root).send({ ...input, candidateId: first.body.candidate.id });
    expect(existing.status).toBe(201);
    expect(existing.body.candidate).toEqual(first.body.candidate);
    expect(await testDb.select().from(candidates)).toHaveLength(2);
  });

  it('returns 404 for an unknown candidate without creating a meeting', async () => {
    const { app } = await loginAs();
    expect((await request(app).post(root).send({ ...input, candidateId: randomUUID() })).status).toBe(404);
    expect(await testDb.select().from(meetings)).toEqual([]);
  });

  it('rolls back the inline candidate when a later database insert fails', async () => {
    const user = await createUser();
    // Deliberate fault after the HTTP boundary: exceed the DB column length so the meeting insert fails.
    await expect(meetingService({ db: testDb, now }).create({
      title: 'x'.repeat(151), description: '', status: 'PENDING', dueDate: now(),
      candidate: { name: 'Must roll back', position: 'Software Engineer' },
    }, user.id)).rejects.toThrow();
    expect(await testDb.select().from(candidates)).toEqual([]);
    expect(await testDb.select().from(meetings)).toEqual([]);
  });

  it('checks cross-field rules against the merged record and supports explicit clearing', async () => {
    const { app } = await loginAs({ now });
    const created = await request(app).post(root).send({ ...input, description: 'Notes',
      endAt: '2026-11-20T04:00:00Z', meetingType: 'ONLINE', provider: 'ZOOM',
      candidate: { name: 'Alice', position: 'Software Engineer' } });
    const url = `${root}/${created.body.id}`;
    const invalidTime = await request(app).patch(url).send({ version: 1, dueDate: '2026-11-20T05:00:00Z' });
    expect(invalidTime.status).toBe(400);
    expect(invalidTime.body.error.details).toContainEqual({ path: 'body.endAt', message: expect.any(String) });
    expect((await request(app).patch(url).send({ version: 1, meetingType: 'ONSITE' })).status).toBe(400);
    const updated = await request(app).patch(url).send({ version: 1, title: ' Revised ', description: '',
      dueDate: '2026-11-20T05:00:00Z', endAt: null, provider: null, meetingType: 'ONSITE', candidateId: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: 'Revised', description: '', version: 2,
      dueDate: '2026-11-20T05:00:00.000Z', endAt: null, candidate: null, meetingType: 'ONSITE', provider: null });
    expect(updated.body.createdAt).toBe(created.body.createdAt);
  });

  it.each([{ version: 1 }, { title: 'No version' }, { version: 0, title: 'Bad' },
    { version: '1', title: 'Bad' }, { version: 1, status: 'CANCELLED' },
    { version: 1, createdAt: '2026-11-20T00:00:00Z' }])('rejects invalid patches: %j', async (body) => {
    const { app } = await loginAs();
    const created = await request(app).post(root).send(input);
    expect((await request(app).patch(`${root}/${created.body.id}`).send(body)).status).toBe(400);
  });

  it('enforces transitions and versions on PATCH, cancel and DELETE', async () => {
    const { app } = await loginAs();
    const created = await request(app).post(root).send(input);
    const url = `${root}/${created.body.id}`;
    expect((await request(app).patch(url).send({ version: 1, status: 'CONFIRMED' })).body.version).toBe(2);
    expect((await request(app).post(`${url}/cancel`).send({ version: 1 })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await request(app).delete(`${url}?version=1`)).status).toBe(409);
    const cancelled = await request(app).post(`${url}/cancel`).send({ version: 2 });
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', version: 3 });
    expect((await request(app).post(`${url}/cancel`).send({ version: 3 })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await request(app).patch(url).send({ version: 3, status: 'CONFIRMED' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await request(app).patch(url).send({ version: 3, title: 'Retained' })).body.status).toBe('CANCELLED');
    expect((await request(app).patch(url).send({ version: 4, status: 'PENDING' })).body.version).toBe(5);
    expect((await request(app).delete(url)).status).toBe(400);
    const removed = await request(app).delete(`${url}?version=5`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await request(app).get(url)).status).toBe(404);
    expect((await request(app).delete(`${url}?version=5`)).status).toBe(404);
  });

  it('allows exactly one of two simultaneous updates holding the same version', async () => {
    const { app } = await loginAs();
    const created = await request(app).post(root).send(input);
    const url = `${root}/${created.body.id}`;
    const results = await Promise.all(['First', 'Second'].map((title) => request(app).patch(url).send({ version: 1, title })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    expect(winner.body.version).toBe(2);
    expect((await request(app).get(url)).body.title).toBe(winner.body.title);
  });

  it('returns explicit newest-first feedback and cascades it on hard delete, not cancel', async () => {
    const { app, user } = await loginAs();
    const created = await request(app).post(root).send(input);
    const url = `${root}/${created.body.id}`;
    await testDb.insert(feedback).values([
      { meetingId: created.body.id, body: 'Older', createdBy: user.id, createdAt: new Date('2026-11-14T00:00:00Z') },
      { meetingId: created.body.id, body: 'Newer', createdBy: user.id, createdAt: now() },
    ]);
    const detail = await request(app).get(url);
    expect(detail.body.feedback.map((f: { body: string }) => f.body)).toEqual(['Newer', 'Older']);
    expect(detail.body.feedback[0]).toEqual({ id: expect.any(String), meetingId: created.body.id,
      body: 'Newer', createdById: user.id, createdAt: now().toISOString() });
    await request(app).post(`${url}/cancel`).send({ version: 1 });
    expect(await testDb.select().from(feedback)).toHaveLength(2);
    await request(app).delete(`${url}?version=2`);
    expect(await testDb.select().from(feedback)).toEqual([]);
  });

  it('does not restrict shared team edits to the creator', async () => {
    const first = await loginAs();
    const second = await loginAs();
    const created = await request(first.app).post(root).send(input);
    const updated = await request(second.app).patch(`${root}/${created.body.id}`).send({ version: 1, title: 'Team edit' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ createdById: first.user.id, isMine: false });
  });

  it('distinguishes malformed ids, missing resources and version conflicts', async () => {
    const { app } = await loginAs();
    expect((await request(app).get(`${root}/not-a-uuid`)).status).toBe(400);
    const url = `${root}/${randomUUID()}`;
    expect((await request(app).get(url)).status).toBe(404);
    expect((await request(app).patch(url).send({ version: 1, title: 'Missing' })).status).toBe(404);
    expect((await request(app).post(`${url}/cancel`).send({ version: 1 })).status).toBe(404);
    expect((await request(app).delete(`${url}?version=1`)).status).toBe(404);
  });

  it('requires authentication for every meeting operation', async () => {
    const app = createTestApp();
    const id = randomUUID();
    const results = await Promise.all([
      request(app).get(root), request(app).get(`${root}/${id}`), request(app).post(root).send(input),
      request(app).patch(`${root}/${id}`).send({ version: 1, title: 'No' }),
      request(app).post(`${root}/${id}/cancel`).send({ version: 1 }), request(app).delete(`${root}/${id}?version=1`),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
  });
});
