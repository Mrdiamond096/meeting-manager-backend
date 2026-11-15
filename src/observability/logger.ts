import { pino } from 'pino';
import { config } from '../config.js';

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.code',
  '*.otp',
  '*.token',
  '*.email',
  'databaseUrl',
];

export const logger = pino({
  level: config.logLevel,
  base: { service: 'api', version: config.appVersion },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  ...(config.logPretty ? { transport: { target: 'pino-pretty' } } : {}),
});
