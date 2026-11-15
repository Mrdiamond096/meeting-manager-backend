import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { candidates, meetings } from '../../src/db/schema/index.js';
import { createTestApp, loginAs } from '../helpers/app.js';
import { createUser, resetDb, testDb } from '../helpers/db.js';

const root = '/api/v1/meetings';
const from = '2026-11-01T00:00:00Z';
const to = '2026-12-13T00:00:00Z';

describe('meeting list and calendar', () => {
  beforeEach(resetDb);

  it('returns empty metadata and an empty page beyond the end', async () => {
    const { app } = await loginAs();
    expect((await request(app).get(root)).body).toEqual({ items: [], page: 1, pageSize: 10, total: 0 });
    expect((await request(app).get(root).query({ page: 999 })).body).toEqual({ items: [], page: 999, pageSize: 10, total: 0 });
  });

  it('uses deterministic date/id ordering and does not lose equal-date items between pages', async () => {
    const { app, user } = await loginAs();
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
    await testDb.insert(meetings).values(ids.map((id) => ({ id, title: id, dueDate: new Date(from), createdBy: user.id })));
    const first = await request(app).get(root).query({ pageSize: 2 });
    const second = await request(app).get(root).query({ pageSize: 2, page: 2 });
    const last = await request(app).get(root).query({ pageSize: 2, page: 3 });
    expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect([...first.body.items, ...second.body.items, ...last.body.items].map((m: { id: string }) => m.id)).toEqual(ids);
    expect((await request(app).get(root).query({ pageSize: 2, page: 4 })).body.items).toEqual([]);
  });

  it('applies combined filters to both page items and count with inclusive from/exclusive to', async () => {
    const { app, user } = await loginAs();
    const other = await createUser();
    const [candidate] = await testDb.insert(candidates).values({ name: 'Alice', position: 'Software Engineer' }).returning();
    const seed = { title: 'Matching', dueDate: new Date(from), candidateId: candidate!.id, createdBy: user.id };
    await testDb.insert(meetings).values([
      seed, { ...seed, status: 'CANCELLED' }, { ...seed, dueDate: new Date(to) },
      { ...seed, createdBy: other.id }, { ...seed, candidateId: null }, { ...seed, createdBy: null },
    ]);
    const filters = { from, to, status: 'PENDING', candidateId: candidate!.id, mine: 'true' };
    const res = await request(app).get(root).query(filters);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ createdById: user.id, isMine: true, dueDate: new Date(from).toISOString() });
    const all = await request(app).get(root).query({ ...filters, mine: 'false' });
    expect(all.body.total).toBe(3);
    expect(all.body.items.filter((m: { isMine: boolean }) => !m.isMine)).toHaveLength(2);
    const missing = await request(app).get(root).query({ candidateId: randomUUID() });
    expect(missing.status).toBe(200);
    expect(missing.body.total).toBe(0);
  });

  it.each([
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e2' }, { page: '9007199254740991' },
    { pageSize: '0' }, { pageSize: '51' }, { pageSize: '' }, { page: ['1', '2'] },
    { unknown: 'yes' }, { mine: '1' }, { mine: ['true', 'false'] }, { candidateId: 'bad' },
    { status: 'COMPLETED' }, { from: '2026-11-20' }, { from: to, to: from }, { from, to: from },
    { view: 'unknown' }, { view: 'range' }, { view: 'range', from }, { view: 'range', to },
    { view: 'range', from, to: '2026-12-13T00:00:00.001Z' },
    { view: 'range', from, to, page: '1' }, { view: 'range', from, to, pageSize: '10' },
    { view: 'range', from, to, candidateId: randomUUID() },
  ])('rejects invalid or ambiguous query parameters: %j', async (query) => {
    const { app } = await loginAs();
    const res = await request(app).get(root).query(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts exactly 42 days and returns only items, not paginated metadata', async () => {
    const { app, user } = await loginAs();
    const other = await createUser();
    await testDb.insert(meetings).values([
      { title: 'Inclusive start', dueDate: new Date(from), createdBy: user.id },
      { title: 'Exclusive end', dueDate: new Date(to), createdBy: user.id },
      { title: 'Cancelled', dueDate: new Date(from), status: 'CANCELLED', createdBy: user.id },
      { title: 'Someone else', dueDate: new Date(from), createdBy: other.id },
    ]);
    const res = await request(app).get(root).query({ view: 'range', from, to, mine: 'true', status: 'PENDING' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['items']);
    expect(res.body.items.map((m: { title: string }) => m.title)).toEqual(['Inclusive start']);
  });

  it('returns 500 matches but rejects 501 instead of truncating the calendar', async () => {
    const { app, user } = await loginAs();
    await testDb.insert(meetings).values(Array.from({ length: 500 }, (_, i) => ({
      title: `Meeting ${i}`, dueDate: new Date(from), createdBy: user.id,
    })));
    const query = { view: 'range', from, to };
    const full = await request(app).get(root).query(query);
    expect(full.status).toBe(200);
    expect(full.body.items).toHaveLength(500);
    await testDb.insert(meetings).values({ title: 'Too many', dueDate: new Date(from) });
    const excess = await request(app).get(root).query(query);
    expect(excess.status).toBe(400);
    expect(excess.body.error.code).toBe('VALIDATION_ERROR');
    // Mine filtering is applied before the cap, not after fetching a truncated global page.
    expect((await request(app).get(root).query({ ...query, mine: 'true' })).body.items).toHaveLength(500);
  });

  it('requires authentication for range queries', async () => {
    const res = await request(createTestApp()).get(root).query({ view: 'range', from, to });
    expect(res.status).toBe(401);
  });

  it('rejects unexpected query keys on resource and write endpoints', async () => {
    const { app } = await loginAs();
    const created = await request(app).post(root).send({ title: 'Meeting', dueDate: from });
    const url = `${root}/${created.body.id}`;
    const results = await Promise.all([
      request(app).get(`${url}?extra=1`), request(app).post(`${root}?extra=1`).send({ title: 'Meeting', dueDate: from }),
      request(app).patch(`${url}?extra=1`).send({ version: 1, title: 'Update' }),
      request(app).post(`${url}/cancel?extra=1`).send({ version: 1 }), request(app).delete(`${url}?version=1&extra=1`),
    ]);
    expect(results.map((r) => r.status)).toEqual([400, 400, 400, 400, 400]);
  });
});

describe('range view validation messages', () => {
  beforeEach(resetDb);

  it('reports the missing range bound instead of an unknown view key', async () => {
    const { app } = await loginAs();
    const res = await request(app).get('/api/v1/meetings?view=range&to=2026-11-20T00:00:00Z');
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'query.from' })]);
  });

  it('rejects an unknown view value', async () => {
    const { app } = await loginAs();
    const res = await request(app).get('/api/v1/meetings?view=week&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('query.view');
  });
});
