import { pino } from 'pino';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default('postgres://meeting:meeting@localhost:5432/meeting'),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_PRETTY: bool.prefault('false'),
  APP_VERSION: z.string().default('dev'),
  RATE_LIMIT_ENABLED: bool.prefault('true'),
  COOKIE_SECURE: bool.prefault('false'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8080,http://localhost:3001')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  OTP_PROVIDER: z.enum(['mock']).default('mock'),
  /** Explicit opt-in for the local Docker demo, which runs the production image. */
  ALLOW_MOCK_OTP: bool.prefault('false'),
  /** Only `make seed` sets this, for one `docker compose exec`. Never set it on the server itself. */
  ALLOW_DEMO_SEED: bool.prefault('false'),
  OTP_MOCK_CODE: z.string().regex(/^\d{6}$/).default('112233'),
});

export type Config = ReturnType<typeof loadConfig>;

/** Invalid environment. `fields` holds variable names only, never their values (they may be secrets). */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(`Invalid environment configuration: ${fields.join(', ')}`, fields);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.OTP_PROVIDER === 'mock' && !e.ALLOW_MOCK_OTP) {
    throw new ConfigError(
      'Mock OTP provider must not be used when NODE_ENV=production (set ALLOW_MOCK_OTP=true only for local demos)',
      ['OTP_PROVIDER', 'ALLOW_MOCK_OTP'],
    );
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    logPretty: e.LOG_PRETTY,
    appVersion: e.APP_VERSION,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    cookieSecure: e.COOKIE_SECURE,
    allowedOrigins: e.ALLOWED_ORIGINS,
    allowDemoSeed: e.ALLOW_DEMO_SEED,
    otp: { provider: e.OTP_PROVIDER, mockCode: e.OTP_MOCK_CODE, allowMockInProduction: e.ALLOW_MOCK_OTP },
  };
}

/**
 * The process-wide config. A bad environment is a `fatal` event (ADR-012): one JSON line on stdout like every other
 * log, then exit 1, instead of an unformatted stack trace the log pipeline cannot parse. The real logger needs the
 * config, so this uses a bare one with the same base fields.
 */
function loadProcessConfig() {
  try {
    return loadConfig();
  } catch (error) {
    const log = pino({ base: { service: 'api' } }, pino.destination({ dest: 1, sync: true }));
    log.fatal(
      { fields: error instanceof ConfigError ? error.fields : [] },
      error instanceof Error ? error.message : 'Invalid environment configuration',
    );
    process.exit(1);
  }
}

export const config = loadProcessConfig();
