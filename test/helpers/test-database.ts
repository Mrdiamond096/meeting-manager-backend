/** Test connections must explicitly name a disposable database, never the application default. */
export function testDatabaseUrl(value: string | undefined): string {
  const refuse = () =>
    new Error(
      'Tests require TEST_DATABASE_URL pointing to a PostgreSQL database whose name ends in _test. Run make test or make test-db first.',
    );
  if (!value) throw refuse();
  let url: URL;
  let database: string;
  try {
    url = new URL(value);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw refuse();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !/^[a-z][a-z0-9_]*_test$/i.test(database)
  ) {
    throw refuse();
  }
  // Do not allow connection-string options to redirect the validated target.
  const targetOptions = new Set([
    'host',
    'port',
    'user',
    'password',
    'database',
    'dbname',
    'service',
  ]);
  for (const key of url.searchParams.keys()) {
    if (targetOptions.has(key.toLowerCase())) throw refuse();
  }
  return value;
}
