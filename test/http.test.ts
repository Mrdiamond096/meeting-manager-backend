import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestApp, loginAs } from './helpers/app.js';
import { resetDb } from './helpers/db.js';

describe('http infrastructure', () => {
  beforeEach(resetDb);

  it('returns 401 with the error shape on protected routes without a session', async () => {
    const res = await request(createTestApp()).get('/api/v1/meetings');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      requestId: expect.any(String),
    });
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });

  it('passes the guard with a stubbed session (loginAs)', async () => {
    const { app } = await loginAs();
    const res = await request(app).get('/api/v1/candidates/unknown/route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('echoes a valid X-Request-Id and replaces an invalid one', async () => {
    const ok = await request(createTestApp()).get('/api/v1/nope').set('X-Request-Id', 'abc-123');
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await request(createTestApp()).get('/api/v1/nope').set('X-Request-Id', 'bad id!');
    expect(bad.headers['x-request-id']).not.toBe('bad id!');
  });

  it('maps malformed JSON to 400 INVALID_JSON', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/anything')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects non-GET requests from a foreign Origin with 403', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/anything')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('lets allowed origins, missing Origin and GET through the origin guard', async () => {
    const app = createTestApp();
    expect(
      (await request(app).post('/api/v1/auth/x').set('Origin', 'http://localhost:8080').send({}))
        .status,
    ).toBe(404);
    expect((await request(app).post('/api/v1/auth/x').send({})).status).toBe(404);
    expect(
      (await request(app).get('/api/v1/auth/x').set('Origin', 'https://evil.example')).status,
    ).toBe(404);
  });

  it('maps bodies over 100kb to 413', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/anything')
      .send({ big: 'x'.repeat(110_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('config', () => {
  it('refuses the mock OTP provider in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', OTP_PROVIDER: 'mock' })).toThrow(/Mock OTP/);
  });

  it('allows the mock in production only with ALLOW_MOCK_OTP=true (local Docker demo)', () => {
    expect(
      loadConfig({ NODE_ENV: 'production', ALLOW_MOCK_OTP: 'true' }).otp.allowMockInProduction,
    ).toBe(true);
  });

  it('rejects invalid values without echoing them', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});
