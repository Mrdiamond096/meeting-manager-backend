import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthenticate } from '../../src/modules/auth/authenticate.js';
import { loginViaApi } from '../helpers/app.js';
import { resetDb, testDb } from '../helpers/db.js';
import { OTP, PASSWORD, sessionToken } from './helpers.js';

/** Through the real createApp: mount point, default OTP provider from config, default bcrypt cost, origin guard. */
describe('auth routes mounted in createApp', () => {
  const now = () => new Date();
  const app = createApp({ db: testDb, pingDb: async () => {}, now, authenticate: createAuthenticate({ db: testDb, now }) });

  beforeEach(resetDb);

  async function register(email: string) {
    const registered = await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD });
    const verified = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: registered.body.challengeId, code: OTP });
    return { registered, verified, cookie: `sid=${sessionToken(verified)}` };
  }

  it('registers and verifies end to end with the default (config) mock OTP', async () => {
    const { registered, verified } = await register('e2e@example.test');

    expect(registered.status).toBe(201);
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email: 'e2e@example.test', role: 'USER' });
    expect(sessionToken(verified)).toHaveLength(43);
    expect(await testDb.session.findMany()).toHaveLength(1);
  });

  it('runs the full cycle: register, log in with OTP, reach a protected route, log out', async () => {
    const email = 'cycle@example.test';
    await register(email);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await request(app).get('/api/v1/meetings')).status).toBe(401);

    const verified = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: login.body.challengeId, code: OTP });
    const cookie = `sid=${sessionToken(verified)}`;

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
    // Through the real guard into the real meetings router.
    const list = await request(app).get('/api/v1/meetings').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);

    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).get('/api/v1/meetings').set('Cookie', cookie)).status).toBe(401);
  });

  it('rejects a registration posted from a foreign Origin before touching the database', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', 'https://evil.example')
      .send({ email: 'csrf@example.test', password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects a cross-site logout and login, and keeps the session alive', async () => {
    const { cookie } = await register('xsrf@example.test');

    const logout = await request(app).post('/api/v1/auth/logout').set('Origin', 'https://evil.example').set('Cookie', cookie);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'xsrf@example.test', password: PASSWORD });

    expect(logout.status).toBe(403);
    expect(login.status).toBe(403);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('accepts the same requests from an allowed Origin', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', 'http://localhost:8080')
      .send({ email: 'ok@example.test', password: PASSWORD });
    expect(res.status).toBe(201);
  });
});

describe('loginViaApi test helper', () => {
  beforeEach(resetDb);

  it('returns a real session cookie that the real guard accepts', async () => {
    const { app, cookie, user } = await loginViaApi();

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    expect((await request(app).get('/api/v1/meetings')).status).toBe(401);
    expect((await request(app).get('/api/v1/meetings').set('Cookie', cookie)).status).toBe(200);
  });
});
