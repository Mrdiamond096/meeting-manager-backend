import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { testDatabaseUrl } from './test-database.js';

export async function setup() {
  const databaseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
  const expectedName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query<{ name: string }>('select current_database() as name');
    if (result.rows[0]?.name !== expectedName) throw new Error('Unexpected database');
  } catch {
    throw new Error('Cannot verify the test database. Check TEST_DATABASE_URL or run make test-db. No migrations were started.');
  } finally {
    await client.end();
  }
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch {
    throw new Error('Test database migrations failed. Check the test database and migration files.');
  }
}
