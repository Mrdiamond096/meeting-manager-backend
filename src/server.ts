import { createApp } from './app.js';
import { config } from './config.js';
import { pingDb, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';

await runMigrations();

const server = createApp({ pingDb }).listen(config.port, () => {
  console.log(`api listening on :${config.port}`);
});

function shutdown() {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
