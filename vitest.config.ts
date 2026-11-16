import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Long-lived test servers instead of one throwaway server per request (see the helper).
    alias: [{ find: /^supertest$/, replacement: fileURLToPath(new URL('test/helpers/supertest.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    // Tests take well under a second; the limit only catches a hang. A busy laptop or CI runner can stall a trivial
    // database round trip for more than the default 5s, which showed up as random failures.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ['test/helpers/global-setup.ts'],
    // Tests share one database and truncate it between cases.
    fileParallelism: false,
    env: { NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'false' },
  },
});
