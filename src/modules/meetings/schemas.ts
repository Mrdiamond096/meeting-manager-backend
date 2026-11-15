import { z } from 'zod';
import { CANDIDATE_POSITIONS } from '../../db/schema/candidates.js';
import { MEETING_PROVIDERS, MEETING_STATUSES, MEETING_TYPES } from '../../db/schema/meetings.js';
import { instant, pagination } from '../../http/validate.js';

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
export const createSchema = z.object({
  ...fields,
  description: fields.description.default(''),
  status: fields.status.default('PENDING'),
  candidate: z.object({ name: text.min(1).max(120), position: z.enum(CANDIDATE_POSITIONS) }).strict().optional(),
}).strict().refine((v) => !(v.candidate && v.candidateId !== undefined), {
  path: ['candidate'], message: 'Choose an existing candidate or create a new one, not both',
});
export const patchSchema = z.object({
  title: fields.title.optional(), description: fields.description.optional(),
  dueDate: fields.dueDate.optional(), endAt: fields.endAt,
  status: fields.status.optional(), meetingType: fields.meetingType,
  provider: fields.provider, candidateId: fields.candidateId, version: positiveVersion,
}).strict().refine((v) => Object.keys(v).some((key) => key !== 'version'), 'Supply at least one changed field');
export const cancelSchema = z.object({ version: positiveVersion }).strict();
export const deleteQuery = z.object({
  version: z.string().regex(/^\d+$/).pipe(z.coerce.number().int().positive().safe()),
}).strict();

const filters = {
  status: z.enum(MEETING_STATUSES).optional(),
  from: instant.optional(), to: instant.optional(),
  mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
};
const pageQuery = z.object({
  ...filters, candidateId: uuid.optional(),
  page: z.string().regex(/^\d+$/).pipe(pagination.page).pipe(z.number().safe()).default('1'),
  pageSize: z.string().regex(/^\d+$/).pipe(pagination.pageSize).default('10'),
}).strict();
const rangeQuery = z.object({ ...filters, view: z.literal('range'), from: instant, to: instant }).strict();
export const listSchema = z.union([rangeQuery, pageQuery]).superRefine((v, ctx) => {
  if (v.from && v.to && v.from >= v.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Must be after from' });
  }
  if ('view' in v && v.to.getTime() - v.from.getTime() > 42 * 86_400_000) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Range must not exceed 42 days' });
  }
  if (!('view' in v) && !Number.isSafeInteger((v.page - 1) * v.pageSize)) {
    ctx.addIssue({ code: 'custom', path: ['page'], message: 'Page offset is too large' });
  }
});
export const meetingState = z.object({
  dueDate: z.date(), endAt: z.date().nullable(),
  meetingType: z.enum(MEETING_TYPES).nullable(), provider: z.enum(MEETING_PROVIDERS).nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.endAt && v.endAt <= v.dueDate) {
    ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'Must be after dueDate' });
  }
  if (v.provider && v.meetingType !== 'ONLINE') {
    ctx.addIssue({ code: 'custom', path: ['provider'], message: 'Provider requires an online meeting' });
  }
});
export type CreateMeeting = z.output<typeof createSchema>;
export type PatchMeeting = z.output<typeof patchSchema>;
export type ListMeetings = z.output<typeof listSchema>;
