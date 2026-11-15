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
  LOG_PRETTY: bool.default('false'),
  APP_VERSION: z.string().default('dev'),
  RATE_LIMIT_ENABLED: bool.default('true'),
  COOKIE_SECURE: bool.default('false'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:8080,http://localhost:3001')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  OTP_PROVIDER: z.enum(['mock']).default('mock'),
  OTP_MOCK_CODE: z.string().regex(/^\d{6}$/).default('112233'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.OTP_PROVIDER === 'mock') {
    throw new Error('Mock OTP provider must not be used when NODE_ENV=production');
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
    otp: { provider: e.OTP_PROVIDER, mockCode: e.OTP_MOCK_CODE },
  };
}

export const config = loadConfig();
