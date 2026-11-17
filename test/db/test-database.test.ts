import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import { resetDb, testDb } from '../helpers/db.js';
import { testDatabaseUrl } from '../helpers/test-database.js';

const originalUrl = config.databaseUrl;
afterEach(() => {
  config.databaseUrl = originalUrl;
  vi.restoreAllMocks();
});

describe('test database safety', () => {
  it.each([
    'postgres://meeting:meeting@localhost:55432/meeting_test',
    'postgresql://meeting:meeting@db/ci_run_test?sslmode=require',
  ])('accepts an explicit test database: %s', (url) => {
    expect(testDatabaseUrl(url)).toBe(url);
  });

  it.each([
    undefined,
    '',
    'not-a-url',
    'https://localhost/meeting_test',
    'postgres://localhost/meeting',
    'postgres://localhost/postgres',
    'postgres://localhost/test',
    'postgres://localhost/meeting_test/other',
    'postgres://localhost/meeting_test%2fother',
    'postgres://localhost/meeting_%ZZ_test',
    'postgres://localhost/meeting_test?dbname=meeting',
    'postgres://localhost/meeting_test?database=meeting',
    'postgres://localhost/meeting_test?host=elsewhere',
  ])('refuses an absent or unsafe connection: %s', (url) => {
    expect(() => testDatabaseUrl(url)).toThrow(/TEST_DATABASE_URL/);
  });

  it('does not include credentials from a refused connection in the error', () => {
    const url = 'postgres://user:private-password@localhost/meeting';
    try {
      testDatabaseUrl(url);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('private-password');
      expect(String(error)).not.toContain(url);
    }
  });

  it('refuses to truncate if the application connection differs from the explicit test target', async () => {
    const execute = vi.spyOn(testDb, '$executeRaw');
    config.databaseUrl = 'postgres://meeting:meeting@localhost:5432/meeting';
    await expect(resetDb()).rejects.toThrow(/Refusing to truncate/);
    expect(execute).not.toHaveBeenCalled();
  });
});
