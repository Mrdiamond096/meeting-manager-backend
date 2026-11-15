import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND'));
};

interface BodyParserError {
  type?: string;
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  const type = (err as BodyParserError | null)?.type;
  if (type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE');
  if (type === 'entity.parse.failed') return new AppError('INVALID_JSON');
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  if (!appError) {
    req.log.error({ err }, 'unhandled error');
  }
  const e = appError ?? new AppError('INTERNAL_ERROR');
  res.status(e.status).json({
    error: {
      code: e.code,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
      requestId: String(req.id),
    },
  });
};
