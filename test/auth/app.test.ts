import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetDb, testDb } from '../helpers/db.js';
import { OTP, PASSWORD, sessionToken } from './helpers.js';

/** Through the real createApp: mount point, default OTP provider from config, default bcrypt cost, origin guard. */
describe('auth routes mounted in createApp', () => {
  const app = createApp({ db: testDb, pingDb: async () => {} });

  beforeEach(resetDb);

  it('registers and verifies end to end with the default (config) mock OTP', async () => {
    const registered = await request(app).post('/api/v1/auth/register').send({ email: 'e2e@example.test', password: PASSWORD });
    expect(registered.status).toBe(201);

    const verified = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: registered.body.challengeId, code: OTP });

    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email: 'e2e@example.test', role: 'USER' });
    expect(sessionToken(verified)).toHaveLength(43);
    expect(await testDb.session.findMany()).toHaveLength(1);
  });

  it('rejects a registration posted from a foreign Origin before touching the database', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', 'https://evil.example')
      .send({ email: 'csrf@example.test', password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });
});
