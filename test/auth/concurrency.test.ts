import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';
import { api, createAuthApp, createClock, OTP, PASSWORD, registerUser, signIn } from './helpers.js';

const ACCOUNTS = 12;
const ROUNDS = 4;

/**
 * Register locks the user row and then the account's challenges; verify must take them in the same order,
 * otherwise PostgreSQL aborts one side with 40P01 (deadlock), which would surface as a 500.
 * The interleaving is timing dependent, so each round fires many accounts at once.
 */
describe('lock ordering under concurrency', () => {
  const server = createAuthApp({ now: createClock().now });
  beforeEach(resetDb);

  it('never answers 500 when register races verify on the same account', async () => {
    const results: { register: number; verify: number }[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const accounts = await Promise.all(
        Array.from({ length: ACCOUNTS }, (_, n) =>
          registerUser(server, `race-${round}-${n}@example.test`),
        ),
      );
      const settled = await Promise.all(
        accounts.map(async ({ email, challengeId }) => {
          const [register, verify] = await Promise.all([
            api(server).register({ email, password: PASSWORD }),
            api(server).verify({ challengeId, code: OTP }),
          ]);
          return { register: register.status, verify: verify.status };
        }),
      );
      results.push(...settled);
    }

    // Either side may win: verified first -> register 409; register first -> verify 400.
    for (const r of results) {
      expect([201, 409]).toContain(r.register);
      expect([200, 400]).toContain(r.verify);
    }
  });

  it('never answers 500 when register, resend and verify race on the same account', async () => {
    const statuses: number[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const accounts = await Promise.all(
        Array.from({ length: ACCOUNTS }, (_, n) =>
          registerUser(server, `triple-${round}-${n}@example.test`),
        ),
      );
      const settled = await Promise.all(
        accounts.flatMap(({ email, challengeId }) => [
          api(server).register({ email, password: PASSWORD }),
          api(server).resend({ challengeId }),
          api(server).verify({ challengeId, code: OTP }),
        ]),
      );
      statuses.push(...settled.map((r) => r.status));
    }

    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it('never answers 500 when login, resend and verify race on a signed-in account', async () => {
    const statuses: number[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const accounts = await Promise.all(
        Array.from({ length: ACCOUNTS }, async (_, n) => {
          const email = `login-${round}-${n}@example.test`;
          await signIn(server, email);
          const login = await api(server).login({ email, password: PASSWORD });
          return { email, challengeId: login.body.challengeId as string };
        }),
      );
      const settled = await Promise.all(
        accounts.flatMap(({ email, challengeId }) => [
          api(server).login({ email, password: PASSWORD }),
          api(server).resend({ challengeId }),
          api(server).verify({ challengeId, code: OTP }),
        ]),
      );
      statuses.push(...settled.map((r) => r.status));
    }

    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it('leaves exactly one open LOGIN challenge when logins on one account run at the same time', async () => {
    const email = 'single-open@example.test';
    await signIn(server, email);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => api(server).login({ email, password: PASSWORD })),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    const open = await testDb.otpChallenge.findMany({
      where: { purpose: 'LOGIN', consumedAt: null },
    });
    expect(open).toHaveLength(1);
  });
});
