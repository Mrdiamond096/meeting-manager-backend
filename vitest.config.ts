import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/helpers/global-setup.ts'],
    // Tests share one database and truncate it between cases.
    fileParallelism: false,
    env: { NODE_ENV: 'test', RATE_LIMIT_ENABLED: 'false' },
  },
});
