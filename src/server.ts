import { createApp } from './app.js';
import { config } from './config.js';
import { db, pingDb } from './db/client.js';
import { createAuthenticate } from './modules/auth/authenticate.js';
import { logger } from './observability/logger.js';

const now = () => new Date();
const server = createApp({ pingDb, db, now, authenticate: createAuthenticate({ db, now }), appVersion: config.appVersion }).listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void db.$disconnect().then(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
