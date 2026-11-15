import { createApp } from './app.js';
import { config } from './config.js';
import { db, pingDb, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './observability/logger.js';

try {
  await runMigrations();
} catch (err) {
  logger.fatal({ err }, 'database migration failed');
  process.exit(1);
}

const server = createApp({ pingDb, db, appVersion: config.appVersion }).listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
