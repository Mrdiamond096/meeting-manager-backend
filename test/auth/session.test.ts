import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthenticate } from '../../src/modules/auth/authenticate.js';
import {
  deleteSessionIfInactive,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  hashSessionToken,
} from '../../src/modules/auth/session.js';
import { resetDb, testDb } from '../helpers/db.js';
import {
  api,
  createAuthApp,
  createClock,
  createLogCapture,
  setCookieHeader,
  signIn,
} from './helpers.js';

const HOUR = 60 * 60 * 1000;

describe('session authentication and GET /auth/me', () => {
  const clock = createClock();
  const app = createAuthApp({ now: clock.now });

  beforeEach(resetDb);

  it('returns 401 without a cookie', async () => {
    const res = await api(app).me();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the signed-in user, never the password hash, and forbids caching', async () => {
    const { email, userId, cookie } = await signIn(app);

    const res = await api(app).me(cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: userId, email, role: 'USER' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['an unknown but well-formed token', `sid=${'A'.repeat(43)}`],
    ['a token of the wrong length', 'sid=short'],
    ['an empty value', 'sid='],
    ['a malformed percent-escape', 'sid=%E0%A4%A'],
    ['another cookie name', `session=${'A'.repeat(43)}`],
  ])('treats %s as not signed in', async (_name, cookie) => {
    const res = await api(app).me(cookie);
    expect(res.status).toBe(401);
  });

  it('finds the sid among several cookies', async () => {
    const { cookie } = await signIn(app);
    const res = await api(app).me(`theme=dark; ${cookie}; other=1`);
    expect(res.status).toBe(200);
  });

  it('keeps two sessions of the same user independent', async () => {
    const first = await signIn(app, 'twice@example.test');
    const login = await api(app).login({
      email: 'twice@example.test',
      password: 'correct horse battery',
    });
    const verified = await api(app).verify({ challengeId: login.body.challengeId, code: '112233' });
    const secondCookie = setCookieHeader(verified).split(';')[0]!;

    await api(app).logout(first.cookie);

    expect((await api(app).me(first.cookie)).status).toBe(401);
    expect((await api(app).me(secondCookie)).status).toBe(200);
  });

  describe('lifetime', () => {
    it('expires after 8 hours without use, and deletes the row', async () => {
      const timed = createClock();
      const timedApp = createAuthApp({ now: timed.now });
      const { cookie } = await signIn(timedApp);

      timed.advance(SESSION_IDLE_MS - 1);
      expect((await api(timedApp).me(cookie)).status).toBe(200);

      // That request counted as use; going idle for the full 8 hours from there ends the session.
      timed.advance(SESSION_IDLE_MS);
      expect((await api(timedApp).me(cookie)).status).toBe(401);
      expect(await testDb.session.findMany()).toHaveLength(0);
    });

    it('stays alive while it is used at least every 8 hours', async () => {
      const timed = createClock();
      const timedApp = createAuthApp({ now: timed.now });
      const { cookie } = await signIn(timedApp);

      for (let i = 0; i < 4; i += 1) {
        timed.advance(7 * HOUR);
        expect((await api(timedApp).me(cookie)).status).toBe(200);
      }
    });

    it('ends at exactly 7 days however active it is (absolute limit)', async () => {
      const timed = createClock();
      const timedApp = createAuthApp({ now: timed.now });
      const { cookie } = await signIn(timedApp);

      const steps = SESSION_ABSOLUTE_MS / (6 * HOUR);
      for (let i = 1; i < steps; i += 1) {
        timed.advance(6 * HOUR);
        expect((await api(timedApp).me(cookie)).status).toBe(200);
      }
      timed.advance(6 * HOUR);
      const res = await api(timedApp).me(cookie);
      expect(res.status).toBe(401);
      expect(await testDb.session.findMany()).toHaveLength(0);
    });

    it('does not delete a session that a parallel request refreshed after we read it', async () => {
      const timed = createClock();
      const { userId, cookie } = await signIn(createAuthApp({ now: timed.now }));
      timed.advance(SESSION_IDLE_MS + 1); // our copy of the row will look idle

      // Same database, but right after the first read of the session another request refreshes it.
      let refreshed = false;
      const db = new Proxy(testDb, {
        get(target, prop, receiver) {
          if (prop !== 'session') return Reflect.get(target, prop, receiver);
          return new Proxy(target.session, {
            get(sessions, method, r) {
              if (method !== 'findUnique') return Reflect.get(sessions, method, r);
              return async (args: Parameters<typeof sessions.findUnique>[0]) => {
                const row = await sessions.findUnique(args);
                if (!refreshed) {
                  refreshed = true;
                  await sessions.updateMany({
                    where: { userId },
                    data: { lastSeenAt: timed.now() },
                  });
                }
                return row;
              };
            },
          });
        },
      });
      const racing = express();
      racing.use(createAuthenticate({ db, now: timed.now }));
      racing.get('/who', (req, res) => res.json({ user: req.user ?? null }));

      const res = await request(racing).get('/who').set('Cookie', cookie);

      expect(res.body.user?.id).toBe(userId);
      expect(await testDb.session.findMany({ where: { userId } })).toHaveLength(1);
    });

    it('deleteSessionIfInactive keeps a session that is active in the database', async () => {
      const timed = createClock();
      const { userId } = await signIn(createAuthApp({ now: timed.now }));
      const session = (await testDb.session.findMany({ where: { userId } }))[0]!;

      expect(await deleteSessionIfInactive(testDb, session.id, timed.now())).toBe(false);
      expect(await testDb.session.count()).toBe(1);

      timed.advance(SESSION_IDLE_MS);
      expect(await deleteSessionIfInactive(testDb, session.id, timed.now())).toBe(true);
      expect(await testDb.session.count()).toBe(0);
    });

    it('only rewrites last_seen_at when it is at least a minute old', async () => {
      const timed = createClock();
      const timedApp = createAuthApp({ now: timed.now });
      const { cookie, userId } = await signIn(timedApp);
      const lastSeen = async () =>
        (await testDb.session.findMany({ where: { userId } }))[0]!.lastSeenAt;
      const start = timed.now();

      timed.advance(SESSION_TOUCH_MS - 1);
      await api(timedApp).me(cookie);
      expect(await lastSeen()).toEqual(start);

      timed.advance(1);
      await api(timedApp).me(cookie);
      expect(await lastSeen()).toEqual(timed.now());
    });
  });

  describe('POST /auth/logout', () => {
    it('deletes the session, clears the cookie and ends access', async () => {
      const { cookie } = await signIn(app);

      const res = await api(app).logout(cookie);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const cleared = setCookieHeader(res);
      expect(cleared).toMatch(/^sid=;/);
      expect(cleared).toContain('Path=/');
      expect(cleared).toContain('HttpOnly');
      expect(cleared).toContain('SameSite=Lax');
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(await testDb.session.findMany()).toHaveLength(0);
      expect((await api(app).me(cookie)).status).toBe(401);
    });

    it('deletes only its own session', async () => {
      const mine = await signIn(app, 'mine@example.test');
      const theirs = await signIn(app, 'theirs@example.test');

      await api(app).logout(mine.cookie);

      const rows = await testDb.session.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(theirs.userId);
    });

    it.each([
      ['no cookie', undefined],
      ['an unknown token', `sid=${'B'.repeat(43)}`],
      ['a malformed cookie', 'sid=%%%'],
    ])('is idempotent with %s', async (_name, cookie) => {
      const { cookie: live } = await signIn(app);

      const res = await api(app).logout(cookie);

      expect(res.status).toBe(204);
      expect(setCookieHeader(res)).toMatch(/^sid=;/);
      expect((await api(app).me(live)).status).toBe(200);
    });

    it('adds Secure to the clearing cookie when cookies are Secure', async () => {
      const secureApp = createAuthApp({ now: clock.now, cookieSecure: true });
      const res = await api(secureApp).logout();
      expect(setCookieHeader(res)).toContain('Secure');
    });
  });

  it('never stores the raw token and never logs it', async () => {
    const capture = createLogCapture();
    const logged = createAuthApp({ now: clock.now, logger: capture.logger });
    const { cookie, userId } = await signIn(logged);
    const token = cookie.slice('sid='.length);

    await api(logged).me(cookie);
    await api(logged).logout(cookie);

    expect(capture.text()).not.toContain(token);
    expect(JSON.stringify(await testDb.session.findMany())).not.toContain(token);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(userId).toBeDefined();
  });
});
