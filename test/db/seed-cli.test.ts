import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoSeedRefusal } from '../../src/db/seed.js';
import { resetDb, testDb } from '../helpers/db.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

/** Runs the real `npm run db:seed` entry point in a clean process against the test database. */
function seedCli(env: Record<string, string>) {
  const run = spawnSync(tsx, ['src/db/seed-cli.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    json: lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const counts = async () => ({
  users: await testDb.user.count(),
  candidates: await testDb.candidate.count(),
  meetings: await testDb.meeting.count(),
  feedback: await testDb.feedback.count(),
});

describe('demoSeedRefusal', () => {
  it.each([
    [{ env: 'production', allowDemoSeed: false }, true],
    [{ env: 'production', allowDemoSeed: true }, false],
    [{ env: 'development', allowDemoSeed: false }, false],
    [{ env: 'test', allowDemoSeed: false }, false],
  ])('%j -> refused: %s', (settings, refused) => {
    expect(demoSeedRefusal(settings) !== undefined).toBe(refused);
  });
});

describe('db:seed entry point', () => {
  beforeEach(resetDb);

  it('refuses in production without ALLOW_DEMO_SEED: one JSON error line, exit 1, nothing written', async () => {
    const run = seedCli({ NODE_ENV: 'production', ALLOW_MOCK_OTP: 'true' });

    expect(run.status).toBe(1);
    expect(run.json).toHaveLength(1);
    expect(run.json[0]).toMatchObject({
      level: 50,
      service: 'seed',
      msg: expect.stringContaining('ALLOW_DEMO_SEED=true'),
    });
    expect(await counts()).toEqual({ users: 0, candidates: 0, meetings: 0, feedback: 0 });
  });

  it('treats ALLOW_DEMO_SEED=false as not allowed', async () => {
    const run = seedCli({
      NODE_ENV: 'production',
      ALLOW_MOCK_OTP: 'true',
      ALLOW_DEMO_SEED: 'false',
    });

    expect(run.status).toBe(1);
    expect(run.json[0]).toMatchObject({ msg: expect.stringContaining('ALLOW_DEMO_SEED=true') });
    expect(await counts()).toEqual({ users: 0, candidates: 0, meetings: 0, feedback: 0 });
  });

  it('does not accept a loose truthy value such as 1', async () => {
    const run = seedCli({ NODE_ENV: 'production', ALLOW_MOCK_OTP: 'true', ALLOW_DEMO_SEED: '1' });

    expect(run.status).toBe(1); // the config only knows "true" and "false" and refuses to start
    expect(await counts()).toEqual({ users: 0, candidates: 0, meetings: 0, feedback: 0 });
  });

  it('runs in production when ALLOW_DEMO_SEED=true, and a second run leaves the same data', async () => {
    const env = { NODE_ENV: 'production', ALLOW_MOCK_OTP: 'true', ALLOW_DEMO_SEED: 'true' };

    const first = seedCli(env);
    expect(first.status).toBe(0);
    expect(first.json).toHaveLength(1);
    expect(first.json[0]).toMatchObject({
      level: 30,
      service: 'seed',
      candidates: 8,
      meetings: 14,
      feedback: 4,
    });
    const afterFirst = await counts();
    const titles = async () =>
      (await testDb.meeting.findMany({ select: { title: true }, orderBy: { title: 'asc' } })).map(
        (m) => m.title,
      );
    const titlesAfterFirst = await titles();

    const second = seedCli(env);
    expect(second.status).toBe(0);
    expect(await counts()).toEqual(afterFirst);
    expect(afterFirst).toEqual({ users: 2, candidates: 8, meetings: 14, feedback: 4 });
    expect(await titles()).toEqual(titlesAfterFirst);
  });

  it('runs without the opt-in outside production', async () => {
    const run = seedCli({ NODE_ENV: 'development' });
    expect(run.status).toBe(0);
    expect(await counts()).toEqual({ users: 2, candidates: 8, meetings: 14, feedback: 4 });
  });

  it('reports a bad override as one JSON error line and exits 1', async () => {
    const run = seedCli({ NODE_ENV: 'development', SEED_DEMO_PASSWORD: 'short' });
    expect(run.status).toBe(1);
    expect(run.json).toHaveLength(1);
    expect(run.json[0]).toMatchObject({
      level: 50,
      msg: expect.stringContaining('SEED_DEMO_PASSWORD'),
    });
  });
});
