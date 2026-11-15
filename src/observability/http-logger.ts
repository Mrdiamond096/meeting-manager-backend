import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import { logger } from './logger.js';

const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

function levelFor(status: number, err?: Error): 'error' | 'warn' | 'info' {
  if (err || status >= 500) return 'error';
  if (status === 413 || status === 429) return 'warn';
  return 'info';
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: requestId,
  customAttributeKeys: { responseTime: 'durationMs' },
  autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/health') },
  customLogLevel: (_req, res, err) => levelFor(res.statusCode, err),
  customProps: (req) => {
    const user = (req as { user?: { id: string } }).user;
    return user ? { userId: user.id } : {};
  },
  serializers: {
    req: (req: { id: unknown; method: string; url: string }) => ({
      requestId: req.id,
      method: req.method,
      path: req.url.split('?')[0],
    }),
    res: (res: { statusCode: number }) => ({ status: res.statusCode }),
  },
  wrapSerializers: false,
});
