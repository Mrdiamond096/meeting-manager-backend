import { z } from 'zod';
import {
  CANDIDATE_POSITIONS,
  MEETING_PROVIDERS,
  MEETING_STATUSES,
  MEETING_TYPES,
} from '../../db/constants.js';
import { digits, instant, pagination } from '../../http/validate.js';

const positiveVersion = z.number().int().positive().safe();
const uuid = z.string().uuid();
const text = z.string().trim();
export const emptyQuery = z.object({}).strict();
const fields = {
  title: text.min(1).max(150),
  description: text.max(5000),
  dueDate: instant,
  endAt: instant.nullable().optional(),
  status: z.enum(['PENDING', 'CONFIRMED']),
  meetingType: z.enum(MEETING_TYPES).nullable().optional(),
  provider: z.enum(MEETING_PROVIDERS).nullable().optional(),
  candidateId: uuid.nullable().optional(),
};
const inlineCandidate = z
  .object({ name: text.min(1).max(120), position: z.enum(CANDIDATE_POSITIONS) })
  .strict();
const eitherCandidate = (v: { candidate?: unknown; candidateId?: unknown }) =>
  !(v.candidate && v.candidateId !== undefined);
const eitherCandidateIssue = {
  path: ['candidate'],
  message: 'Choose an existing candidate or create a new one, not both',
};
export const createSchema = z
  .object({
    ...fields,
    description: fields.description.default(''),
    status: fields.status.default('PENDING'),
    candidate: inlineCandidate.optional(),
  })
  .strict()
  .refine(eitherCandidate, eitherCandidateIssue);
export const patchSchema = z
  .object({
    title: fields.title.optional(),
    description: fields.description.optional(),
    dueDate: fields.dueDate.optional(),
    endAt: fields.endAt,
    status: fields.status.optional(),
    meetingType: fields.meetingType,
    provider: fields.provider,
    candidateId: fields.candidateId,
    candidate: inlineCandidate.optional(),
    version: positiveVersion,
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((key) => key !== 'version'),
    'Supply at least one changed field',
  )
  .refine(eitherCandidate, eitherCandidateIssue);
export const cancelSchema = z.object({ version: positiveVersion }).strict();
export const deleteQuery = z
  .object({
    version: digits.pipe(z.number().int().positive().safe()),
  })
  .strict();

const filters = {
  status: z.enum(MEETING_STATUSES).optional(),
  from: instant.optional(),
  to: instant.optional(),
  mine: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
};
const pageQuery = z
  .object({
    ...filters,
    candidateId: uuid.optional(),
    page: digits.pipe(pagination.page).prefault('1'),
    pageSize: digits.pipe(pagination.pageSize).prefault('10'),
  })
  .strict();
const rangeQuery = z
  .object({ ...filters, view: z.literal('range'), from: instant, to: instant })
  .strict();
const rangeChecks = (v: { from?: Date; to?: Date }, ctx: z.RefinementCtx) => {
  if (v.from && v.to && v.from >= v.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Must be after from' });
  }
};
/**
 * Zod 4 runs object-level refinements even when a field failed its format check, with the raw input in
 * place of the parsed value (a bad `from` is still a string). Cross-field rules need parsed values, so
 * they only run once every field is valid; the field's own issue is what the client should see.
 */
const pageListSchema = pageQuery.superRefine((v, ctx) => {
  if (ctx.issues.length > 0) return;
  rangeChecks(v, ctx);
  if (!Number.isSafeInteger((v.page - 1) * v.pageSize)) {
    ctx.addIssue({ code: 'custom', path: ['page'], message: 'Page offset is too large' });
  }
});
const rangeListSchema = rangeQuery.superRefine((v, ctx) => {
  if (ctx.issues.length > 0) return;
  rangeChecks(v, ctx);
  if (v.to.getTime() - v.from.getTime() > 42 * 86_400_000) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Range must not exceed 42 days' });
  }
});
/** Picks the schema by `view` so a bad range query reports its own missing fields, not "unknown key view". */
export const listSchemaFor = (query: Record<string, unknown>) =>
  query.view === undefined ? pageListSchema : rangeListSchema;
export const meetingState = z
  .object({
    dueDate: z.date(),
    endAt: z.date().nullable(),
    meetingType: z.enum(MEETING_TYPES).nullable(),
    provider: z.enum(MEETING_PROVIDERS).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.endAt && v.endAt <= v.dueDate) {
      ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'Must be after dueDate' });
    }
    if (v.provider && v.meetingType !== 'ONLINE') {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Provider requires an online meeting',
      });
    }
  });
export type CreateMeeting = z.output<typeof createSchema>;
export type PatchMeeting = z.output<typeof patchSchema>;
export type ListMeetings = z.output<typeof pageListSchema> | z.output<typeof rangeListSchema>;
