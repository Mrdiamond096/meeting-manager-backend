import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** Loads the real module in a fresh process, the way `node dist/server.js` does at startup. */
function boot(env: Record<string, string>) {
  const run = spawnSync(tsx, ['-e', "import('./src/config.ts')"], {
    cwd: root,
    // A clean environment: nothing from the test run (NODE_ENV=test, DATABASE_URL...) leaks in.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('startup with an invalid environment', () => {
  it('logs one fatal JSON line naming the variables, then exits with 1', () => {
    const { status, stdout, stderr } = boot({ PORT: 'abc', OTP_MOCK_CODE: '12' });

    expect(status).toBe(1);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 60,
      service: 'api',
      fields: ['PORT', 'OTP_MOCK_CODE'],
      msg: 'Invalid environment configuration: PORT, OTP_MOCK_CODE',
    });
    expect(stderr).not.toContain('at '); // no stack trace
  });

  it('refuses the mock OTP provider in production the same way', () => {
    const { status, stdout } = boot({ NODE_ENV: 'production', OTP_PROVIDER: 'mock' });

    expect(status).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      level: 60,
      fields: ['OTP_PROVIDER', 'ALLOW_MOCK_OTP'],
      msg: expect.stringContaining('Mock OTP provider must not be used'),
    });
  });

  it('never prints the value of a bad variable', () => {
    const secret = 'hunter2-not-a-url';
    const { stdout, stderr } = boot({ DATABASE_URL: secret });

    expect(JSON.parse(stdout.trim()).fields).toEqual(['DATABASE_URL']);
    expect(stdout + stderr).not.toContain(secret);
  });

  it('starts normally, printing nothing, with a valid environment', () => {
    const { status, stdout } = boot({ NODE_ENV: 'production', ALLOW_MOCK_OTP: 'true' });

    expect(status).toBe(0);
    expect(stdout).toBe('');
  });
});

describe('loadConfig', () => {
  it('still throws a ConfigError (not exit) so it stays testable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('lists each bad variable once', () => {
    try {
      loadConfig({ OTP_MOCK_CODE: 'x' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).fields).toEqual(['OTP_MOCK_CODE']);
    }
  });
});

describe('rate limits', () => {
  it('default to ADR-013', () => {
    const { rateLimits } = loadConfig({});
    expect(rateLimits).toEqual({
      login: { limit: 5, windowMs: 15 * 60_000 },
      register: { limit: 3, windowMs: 60 * 60_000 },
      forgotPassword: { limit: 3, windowMs: 60 * 60_000 },
      otpResend: { limit: 10, windowMs: 15 * 60_000 },
      passwordReset: { limit: 10, windowMs: 15 * 60_000 },
      write: { limit: 60, windowMs: 60_000 },
    });
  });

  it('accept the bounds', () => {
    expect(loadConfig({ RATE_LIMIT_LOGIN: '999999/1440' }).rateLimits.login).toEqual({
      limit: 999_999,
      windowMs: 1440 * 60_000,
    });
  });

  it('take max/minutes from RATE_LIMIT_*', () => {
    expect(loadConfig({ RATE_LIMIT_REGISTER: '100/60' }).rateLimits.register).toEqual({
      limit: 100,
      windowMs: 60 * 60_000,
    });
  });

  it.each([
    '3',
    '3/0',
    '0/60',
    '-1/60',
    '3/60m',
    'abc',
    '1/1441',
    '1/43200',
    '1000001/60',
    `${'9'.repeat(400)}/60`,
  ])('reject %s', (value) => {
    expect(() => loadConfig({ RATE_LIMIT_LOGIN: value })).toThrow(ConfigError);
  });
});
