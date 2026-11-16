import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from '../helpers/app.js';
import { resetDb, testDb } from '../helpers/db.js';

const now = () => new Date('2026-11-15T09:00:00.000Z');
const url = (id: string) => `/api/v1/meetings/${id}/feedback`;
const seed = () => testDb.meeting.create({ data: { title: 'Interview', dueDate: now() } });

describe('feedback', () => {
  beforeEach(resetDb);

  it('appends attributed, timestamped plain-text entries without overwriting earlier feedback', async () => {
    const { app, user } = await loginAs({ now });
    const meeting = await seed();
    const first = await request(app).post(url(meeting.id)).send({ body: ' First note ' });
    const second = await request(app).post(url(meeting.id)).send({ body: '<script>plain text</script>' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual({ id: expect.any(String), meetingId: meeting.id, body: 'First note',
      createdById: user.id, createdAt: now().toISOString() });
    expect(second.body.id).not.toBe(first.body.id);
    const rows = await testDb.feedback.findMany();
    expect(rows.map((row) => row.body)).toEqual(expect.arrayContaining(['First note', '<script>plain text</script>']));
    expect(rows).toHaveLength(2);
    const unchanged = await testDb.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(unchanged?.version).toBe(1);
  });

  it.each([{}, { body: '' }, { body: '   ' }, { body: 'x'.repeat(5001) }, { body: null }, { body: 123 },
    { body: 'Note', createdById: randomUUID() }, { body: 'Note', meetingId: randomUUID() }, { body: 'Note', extra: true }])
  ('rejects invalid body or client-owned attribution: %j', async (body) => {
    const { app } = await loginAs();
    const meeting = await seed();
    const res = await request(app).post(url(meeting.id)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect(await testDb.feedback.findMany()).toEqual([]);
  });

  it('accepts the exact 5000-character boundary', async () => {
    const { app } = await loginAs();
    const meeting = await seed();
    expect((await request(app).post(url(meeting.id)).send({ body: 'x'.repeat(5000) })).status).toBe(201);
  });

  it('separates malformed id, missing meeting and unexpected query errors', async () => {
    const { app } = await loginAs();
    const missing = await request(app).post(url(randomUUID())).send({ body: 'Note' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).post(url('bad-id')).send({ body: 'Note' })).status).toBe(400);
    const meeting = await seed();
    expect((await request(app).post(`${url(meeting.id)}?extra=1`).send({ body: 'Note' })).status).toBe(400);
    expect(await testDb.feedback.findMany()).toEqual([]);
  });

  it('requires a session, but permits any authenticated team member', async () => {
    const first = await loginAs();
    const second = await loginAs();
    const meeting = await testDb.meeting.create({ data: { title: 'Owned by first', dueDate: now(), createdBy: first.user.id } });
    expect((await request(createTestApp()).post(url(meeting!.id)).send({ body: 'Anonymous' })).status).toBe(401);
    const res = await request(second.app).post(url(meeting!.id)).send({ body: 'Team note' });
    expect(res.status).toBe(201);
    expect(res.body.createdById).toBe(second.user.id);
  });

  it('exposes no update or delete endpoints for feedback', async () => {
    const { app } = await loginAs();
    const meeting = await seed();
    const created = await request(app).post(url(meeting.id)).send({ body: 'Immutable' });
    const endpoint = `${url(meeting.id)}/${created.body.id}`;
    expect((await request(app).patch(endpoint).send({ body: 'Changed' })).status).toBe(404);
    expect((await request(app).delete(endpoint)).status).toBe(404);
    expect((await testDb.feedback.findMany())[0]?.body).toBe('Immutable');
  });

  it('retains notes when cancelled and cascades only feedback for the deleted meeting', async () => {
    const { app } = await loginAs();
    const first = await seed();
    const second = await seed();
    await request(app).post(url(first.id)).send({ body: 'First' });
    await request(app).post(url(second.id)).send({ body: 'Second' });
    await testDb.meeting.update({ where: { id: first.id }, data: { status: 'CANCELLED' } });
    expect(await testDb.feedback.findMany()).toHaveLength(2);
    await testDb.meeting.delete({ where: { id: first.id } });
    const remaining = await testDb.feedback.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.meetingId).toBe(second.id);
  });

  it('handles concurrent append/deletion without leaking a foreign-key failure', async () => {
    const { app } = await loginAs();
    const meeting = await seed();
    const [res] = await Promise.all([
      request(app).post(url(meeting.id)).send({ body: 'Racing note' }),
      testDb.meeting.delete({ where: { id: meeting.id } }),
    ]);
    expect([201, 404]).toContain(res.status);
    expect(await testDb.feedback.findMany()).toEqual([]);
  });
});
