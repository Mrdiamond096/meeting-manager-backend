import { pino } from 'pino';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * A rate limit as `max/minutes`, e.g. `3/60` = 3 requests per 60 minutes. Bounded: at most 999999 requests per
 * window and 1440 minutes (a day). The in-memory store's timer silently breaks above about 24.8 days.
 */
const MAX_WINDOW_MINUTES = 1440;
const rateLimit = (fallback: string) =>
  z
    .string()
    .regex(/^[1-9]\d{0,5}\/[1-9]\d{0,3}$/)
    .refine((v) => Number(v.split('/')[1]) <= MAX_WINDOW_MINUTES)
    .default(fallback)
    .transform((v) => {
      const [limit, minutes] = v.split('/').map(Number) as [number, number];
      return { limit, windowMs: minutes * 60_000 };
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default('postgres://meeting:meeting@localhost:5432/meeting'),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_PRETTY: bool.prefault('false'),
  APP_VERSION: z.string().default('dev'),
  RATE_LIMIT_ENABLED: bool.prefault('true'),
  // Defaults are ADR-013.
  RATE_LIMIT_LOGIN: rateLimit('5/15'),
  RATE_LIMIT_REGISTER: rateLimit('3/60'),
  RATE_LIMIT_FORGOT_PASSWORD: rateLimit('3/60'),
  RATE_LIMIT_OTP_RESEND: rateLimit('10/15'),
  RATE_LIMIT_PASSWORD_RESET: rateLimit('10/15'),
  RATE_LIMIT_WRITE: rateLimit('60/1'),
  COOKIE_SECURE: bool.prefault('false'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8080,http://localhost:3001')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /** Accounts registered with these emails become ADMIN (ADR-015); comma-separated, matched lowercase. */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  OTP_PROVIDER: z.enum(['mock']).default('mock'),
  /** Explicit opt-in for the local Docker demo, which runs the production image. */
  ALLOW_MOCK_OTP: bool.prefault('false'),
  /** Opt-in for a one-off demo seed command. Never enable it on the running server. */
  ALLOW_DEMO_SEED: bool.prefault('false'),
  OTP_MOCK_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .default('112233'),
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
    rateLimits: {
      login: e.RATE_LIMIT_LOGIN,
      register: e.RATE_LIMIT_REGISTER,
      forgotPassword: e.RATE_LIMIT_FORGOT_PASSWORD,
      otpResend: e.RATE_LIMIT_OTP_RESEND,
      passwordReset: e.RATE_LIMIT_PASSWORD_RESET,
      write: e.RATE_LIMIT_WRITE,
    },
    cookieSecure: e.COOKIE_SECURE,
    allowedOrigins: e.ALLOWED_ORIGINS,
    adminEmails: e.ADMIN_EMAILS,
    allowDemoSeed: e.ALLOW_DEMO_SEED,
    otp: {
      provider: e.OTP_PROVIDER,
      mockCode: e.OTP_MOCK_CODE,
      allowMockInProduction: e.ALLOW_MOCK_OTP,
    },
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
