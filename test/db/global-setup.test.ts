import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  migrate: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.migrate }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: unknown) {
      mocks.createClient(options);
    }
    connect = mocks.connect;
    query = mocks.query;
    end = mocks.end;
  },
}));
import { setup } from '../helpers/global-setup.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [{ name: 'meeting_test' }] });
  mocks.end.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('database setup guard', () => {
  it.each([undefined, 'postgres://user:secret@localhost/meeting'])(
    'refuses %s before connecting or migrating',
    async (url) => {
      vi.stubEnv('TEST_DATABASE_URL', url);
      await expect(setup()).rejects.toThrow(/TEST_DATABASE_URL/);
      expect(mocks.createClient).not.toHaveBeenCalled();
      expect(mocks.migrate).not.toHaveBeenCalled();
    },
  );

  it('refuses an unexpected server database before migrations', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://localhost/meeting_test');
    mocks.query.mockResolvedValue({ rows: [{ name: 'meeting' }] });
    await expect(setup()).rejects.toThrow(/No migrations were started/);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('refuses a failed connection before migrations without leaking its error', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://localhost/meeting_test');
    mocks.connect.mockRejectedValue(new Error('private-password'));
    await expect(setup()).rejects.toThrow(/Cannot verify the test database/);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('migrates only the verified explicit target, overriding an inherited application URL', async () => {
    const target = 'postgres://localhost/meeting_test';
    vi.stubEnv('TEST_DATABASE_URL', target);
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/meeting');
    await setup();
    expect(mocks.createClient).toHaveBeenCalledWith({
      connectionString: target,
      connectionTimeoutMillis: 5000,
    });
    expect(mocks.query).toHaveBeenCalledWith('select current_database() as name');
    expect(mocks.migrate).toHaveBeenCalledWith('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe',
      env: expect.objectContaining({ DATABASE_URL: target }),
    });
  });
});
