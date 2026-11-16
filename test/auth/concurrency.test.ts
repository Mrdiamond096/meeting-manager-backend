import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db.js';
import { api, createAuthApp, createClock, OTP, PASSWORD, registerUser } from './helpers.js';

const ACCOUNTS = 12;
const ROUNDS = 4;

/**
 * Register locks the user row and then the account's challenges; verify must take them in the same order,
 * otherwise PostgreSQL aborts one side with 40P01 (deadlock), which would surface as a 500.
 * The interleaving is timing dependent, so each round fires many accounts at once.
 */
describe('lock ordering under concurrency', () => {
  beforeEach(resetDb);

  it('never answers 500 when register races verify on the same account', async () => {
    const app = createAuthApp({ now: createClock().now });
    const results: { register: number; verify: number }[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const accounts = await Promise.all(
        Array.from({ length: ACCOUNTS }, (_, n) => registerUser(app, `race-${round}-${n}@example.test`)),
      );
      const settled = await Promise.all(
        accounts.map(async ({ email, challengeId }) => {
          const [register, verify] = await Promise.all([
            api(app).register({ email, password: PASSWORD }),
            api(app).verify({ challengeId, code: OTP }),
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
    const app = createAuthApp({ now: createClock().now });
    const statuses: number[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const accounts = await Promise.all(
        Array.from({ length: ACCOUNTS }, (_, n) => registerUser(app, `triple-${round}-${n}@example.test`)),
      );
      const settled = await Promise.all(
        accounts.flatMap(({ email, challengeId }) => [
          api(app).register({ email, password: PASSWORD }),
          api(app).resend({ challengeId }),
          api(app).verify({ challengeId, code: OTP }),
        ]),
      );
      statuses.push(...settled.map((r) => r.status));
    }

    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });
});
