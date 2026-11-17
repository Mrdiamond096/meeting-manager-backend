import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/http/errors.js';
import { instant, parse } from '../src/http/validate.js';

describe('validate helpers', () => {
  it('throws VALIDATION_ERROR with located details', () => {
    const schema = z.object({ title: z.string().min(1) }).strict();
    try {
      parse(schema, { title: '', extra: 1 }, 'body');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.status).toBe(400);
      expect(e.details?.map((d) => d.path)).toEqual(expect.arrayContaining(['body.title', 'body']));
    }
  });

  it('instant accepts offsets and rejects date-only or offset-less values', () => {
    expect(instant.parse('2026-11-20T10:00:00+07:00').toISOString()).toBe(
      '2026-11-20T03:00:00.000Z',
    );
    expect(instant.safeParse('2026-11-20').success).toBe(false);
    expect(instant.safeParse('2026-11-20T10:00:00').success).toBe(false);
  });
});
