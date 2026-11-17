import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './test/helpers/test-database.js';

const databaseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
// The explicit test target takes precedence over any inherited application connection.
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  resolve: {
    // Long-lived test servers instead of one throwaway server per request (see the helper).
    alias: [
      {
        find: /^supertest$/,
        replacement: fileURLToPath(new URL('test/helpers/supertest.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    // Allow for database and password-hashing latency while keeping stalled tests bounded.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ['test/helpers/global-setup.ts'],
    // Tests share one database and truncate it between cases.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      RATE_LIMIT_ENABLED: 'false',
      // Keep application/demo overrides out of tests that assert the default rate limits.
      RATE_LIMIT_LOGIN: '5/15',
      RATE_LIMIT_REGISTER: '3/60',
      RATE_LIMIT_FORGOT_PASSWORD: '3/60',
      RATE_LIMIT_OTP_RESEND: '10/15',
      RATE_LIMIT_PASSWORD_RESET: '10/15',
      RATE_LIMIT_WRITE: '60/1',
    },
  },
});
