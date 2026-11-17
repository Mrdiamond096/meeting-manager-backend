import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRateLimits } from '../src/http/rate-limit.js';
import { createTestApp, loginAs } from './helpers/app.js';
import { resetDb } from './helpers/db.js';

function limitedApp(limit: number, enabled = true) {
  const settings = loadConfig({
    RATE_LIMIT_ENABLED: String(enabled),
    RATE_LIMIT_LOGIN: `${limit}/1`,
  });
  const app = express();
  app.use(express.json());
  app.post('/', createRateLimits(settings).login(), (_req, res) => res.sendStatus(204));
  app.use(
    (
      err: { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: { code: err.code } });
    },
  );
  return app;
}

describe('injected rate limits', () => {
  beforeEach(resetDb);

  it('keeps simultaneous app quotas separate and honors different settings', async () => {
    const first = limitedApp(1);
    const second = limitedApp(2);
    expect((await request(first).post('/').send({ email: 'one@example.test' })).status).toBe(204);
    const blocked = await request(first).post('/').send({ email: 'one@example.test' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy']).toBe('1;w=60');
    expect((await request(second).post('/').send({ email: 'one@example.test' })).status).toBe(204);
    expect((await request(second).post('/').send({ email: 'one@example.test' })).status).toBe(204);
    expect((await request(second).post('/').send({ email: 'one@example.test' })).status).toBe(429);
  });

  it('can disable one app without changing another app or the global configuration', async () => {
    const enabled = limitedApp(1);
    const disabled = limitedApp(1, false);
    expect((await request(enabled).post('/')).status).toBe(204);
    expect((await request(enabled).post('/')).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await request(disabled).post('/')).status).toBe(204);
    expect((await request(enabled).post('/')).status).toBe(429);
  });

  it('preserves case-insensitive email keys within an IP', async () => {
    const app = limitedApp(1);
    expect((await request(app).post('/').send({ email: ' Person@Example.test ' })).status).toBe(
      204,
    );
    expect((await request(app).post('/').send({ email: 'person@example.test' })).status).toBe(429);
    expect((await request(app).post('/').send({ email: 'other@example.test' })).status).toBe(204);
  });

  it('passes per-app configuration to auth routes in createApp', async () => {
    const app = createTestApp({
      rateLimitConfig: loadConfig({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_REGISTER: '1/1' }),
    });
    // Invalid bodies still consume the IP quota before validation, without creating accounts.
    expect((await request(app).post('/api/v1/auth/register').send({})).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/register').send({})).status).toBe(429);
  });

  it('passes per-app configuration to authenticated writes without limiting reads', async () => {
    const { app } = await loginAs({
      rateLimitConfig: loadConfig({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_WRITE: '1/1' }),
    });
    expect((await request(app).post('/api/v1/candidates').send({})).status).toBe(400);
    expect((await request(app).post('/api/v1/candidates').send({})).status).toBe(429);
    expect((await request(app).get('/api/v1/candidates').query({ q: 'Alice' })).status).toBe(200);
  });
});
