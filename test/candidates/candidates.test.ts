import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { candidates, meetings } from '../../src/db/schema/index.js';
import { createTestApp, loginAs } from '../helpers/app.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const root = '/api/v1/candidates';
const now = () => new Date('2026-11-15T09:00:00.000Z');
const input = { name: ' Alice ', position: 'Software Engineer' };

describe('candidates', () => {
  beforeEach(resetDb);

  it('creates distinct identities for identical names and returns only CandidateSummary', async () => {
    const { app, user } = await loginAs({ now });
    const first = await request(app).post(root).send(input);
    const second = await request(app).post(root).send(input);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual({ id: expect.any(String), name: 'Alice', position: 'Software Engineer', createdAt: now().toISOString() });
    expect(second.body.id).not.toBe(first.body.id);
    const rows = await testDb.select().from(candidates);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.createdBy === user.id)).toBe(true);
  });

  it.each([{}, { ...input, name: ' ' }, { ...input, name: 'x'.repeat(121) },
    { ...input, position: 'Unknown' }, { ...input, createdById: randomUUID() }])('rejects invalid create fields: %j', async (body) => {
    const { app } = await loginAs();
    const res = await request(app).post(root).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await testDb.select().from(candidates)).toEqual([]);
  });

  it('searches names case-insensitively, caps at ten and returns newest first', async () => {
    const { app } = await loginAs();
    const rows = await testDb.insert(candidates).values(Array.from({ length: 12 }, (_, i) => ({
      name: `Alice ${i}`, position: 'Software Engineer', createdAt: new Date(Date.UTC(2026, 10, i + 1)),
    }))).returning();
    const res = await request(app).get(root).query({ q: ' aLiCe ' });
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { id: string }) => c.id)).toEqual(rows.slice(2).reverse().map((row) => row.id));
    expect((await request(app).get(root).query({ q: 'unmatched' })).body).toEqual({ items: [] });
  });

  it('treats SQL patterns and injection-looking text as literal search text', async () => {
    const { app } = await loginAs();
    await testDb.insert(candidates).values([
      { name: '100%_\\Alice', position: 'Software Engineer' },
      { name: '100xyzAlice', position: 'Software Engineer' },
    ]);
    const res = await request(app).get(root).query({ q: '100%_\\' });
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['100%_\\Alice']);
    expect((await request(app).get(root).query({ q: "' OR 1=1 --" })).body.items).toEqual([]);
  });

  it.each([{}, { q: '' }, { q: ' ' }, { q: 'x'.repeat(121) }, { q: ['a', 'b'] }, { q: 'Alice', extra: 'yes' }])
  ('rejects invalid search queries: %j', async (query) => {
    const { app } = await loginAs();
    expect((await request(app).get(root).query(query)).status).toBe(400);
  });

  it('serves positions before the id route and validates the exact approved list', async () => {
    const { app } = await loginAs();
    const res = await request(app).get(`${root}/positions`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(['Software Engineer', 'Frontend Engineer', 'Backend Engineer', 'Full Stack Engineer',
      'QA Engineer', 'Data Engineer', 'DevOps Engineer', 'Product Designer', 'Product Manager']);
    expect((await request(app).get(`${root}/positions?extra=1`)).status).toBe(400);
  });

  it('partitions upcoming/history at the injected instant and does not merge identical-name profiles', async () => {
    const { app, user } = await loginAs({ now });
    const other = await createUser();
    const first = await request(app).post(root).send(input);
    const second = await request(app).post(root).send(input);
    const candidateId = first.body.id;
    const rows = await testDb.insert(meetings).values([
      { title: 'At boundary', dueDate: now(), candidateId, createdBy: user.id },
      { title: 'Future', dueDate: new Date('2026-11-20T00:00:00Z'), candidateId, createdBy: other.id },
      { title: 'Past', dueDate: new Date('2026-11-10T00:00:00Z'), candidateId },
      { title: 'Cancelled future', dueDate: new Date('2026-11-22T00:00:00Z'), candidateId, status: 'CANCELLED' },
      { title: 'Cancelled past', dueDate: new Date('2026-11-09T00:00:00Z'), candidateId, status: 'CANCELLED' },
      { title: 'Different person', dueDate: now(), candidateId: second.body.id },
      { title: 'Generic', dueDate: now() },
    ]).returning();
    const res = await request(app).get(`${root}/${candidateId}`);
    expect(res.status).toBe(200);
    expect(res.body.candidate).toEqual(first.body);
    expect(res.body.upcoming.map((m: { title: string }) => m.title)).toEqual(['At boundary', 'Future']);
    expect(res.body.history.map((m: { title: string }) => m.title)).toEqual(['Cancelled future', 'Past', 'Cancelled past']);
    expect(res.body.upcoming[0]).toEqual({ id: rows[0]!.id, title: 'At boundary', description: '',
      dueDate: now().toISOString(), endAt: null, status: 'PENDING', meetingType: null, provider: null,
      candidate: first.body, createdById: user.id, isMine: true, version: 1,
      createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(res.body.upcoming[1].isMine).toBe(false);
    expect(res.body.history[1].createdById).toBeNull();
    expect((await request(app).get(`${root}/${second.body.id}`)).body.upcoming).toHaveLength(1);
  });

  it('returns an empty profile, 400 malformed id and 404 missing candidate as distinct cases', async () => {
    const { app } = await loginAs();
    const created = await request(app).post(root).send(input);
    expect((await request(app).get(`${root}/${created.body.id}`)).body).toEqual({ candidate: created.body, upcoming: [], history: [] });
    expect((await request(app).get(`${root}/not-a-uuid`)).status).toBe(400);
    expect((await request(app).get(`${root}/${randomUUID()}`)).status).toBe(404);
    expect((await request(app).get(`${root}/${created.body.id}?extra=1`)).status).toBe(400);
  });

  it('requires authentication for search, positions, creation and profiles', async () => {
    const app = createTestApp();
    const results = await Promise.all([request(app).get(root).query({ q: 'Alice' }), request(app).get(`${root}/positions`),
      request(app).post(root).send(input), request(app).get(`${root}/${randomUUID()}`)]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401]);
  });
});
