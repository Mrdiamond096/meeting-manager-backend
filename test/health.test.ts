import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

const down = async () => {
  throw new Error('db down');
};

describe('health', () => {
  it('GET /api/health/live returns ok with version', async () => {
    const res = await request(createTestApp({ pingDb: down })).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: 'dev' });
  });

  it('GET /api/health/ready returns ok when db reachable', async () => {
    const res = await request(createTestApp()).get('/api/health/ready');
    expect(res.status).toBe(200);
  });

  it('GET /api/health/ready returns 503 when db unreachable', async () => {
    const res = await request(createTestApp({ pingDb: down })).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });
});
