import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema/index.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  statement_timeout: config.dbStatementTimeoutMs,
});
export const db = drizzle(pool, { schema });

export type Database = NodePgDatabase<typeof schema>;

export async function pingDb(): Promise<void> {
  await pool.query('select 1');
}
