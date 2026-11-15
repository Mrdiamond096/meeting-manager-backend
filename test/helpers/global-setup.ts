import { runMigrations } from '../../src/db/migrate.js';
import { pool } from '../../src/db/client.js';

export async function setup() {
  try {
    await runMigrations();
  } catch (err) {
    throw new Error(`Tests need PostgreSQL at DATABASE_URL (try: docker compose up -d db). ${String(err)}`);
  } finally {
    await pool.end();
  }
}
