import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors.js';

type Location = 'body' | 'query' | 'params';

export function parse<S extends ZodTypeAny>(schema: S, value: unknown, location: Location): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      undefined,
      result.error.issues.map((i) => ({
        path: [location, ...i.path].join('.'),
        message: i.message,
      })),
    );
  }
  return result.data;
}

export const parseBody = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.body ?? {}, 'body');
export const parseQuery = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.query, 'query');
export const parseParams = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.params, 'params');

/** RFC 3339 instant with explicit offset (Z or ±hh:mm); date-only is rejected (ADR-005). */
export const instant = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));

export const idParams = z.object({ id: z.string().uuid() }).strict();

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
};

export const version = z.coerce.number().int().positive();
