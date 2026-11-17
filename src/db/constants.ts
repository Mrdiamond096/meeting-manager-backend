/** Fixed list shown in the booking form; validated at the API (not a DB enum, so it can grow without a migration). */
export const CANDIDATE_POSITIONS = [
  'Software Engineer',
  'Frontend Engineer',
  'Backend Engineer',
  'Full Stack Engineer',
  'QA Engineer',
  'Data Engineer',
  'DevOps Engineer',
  'Product Designer',
  'Product Manager',
] as const;

export const MEETING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED'] as const;
export const MEETING_TYPES = ['ONSITE', 'ONLINE'] as const;
export const MEETING_PROVIDERS = ['ZOOM', 'GOOGLE_MEET', 'OTHER'] as const;
export const OTP_PURPOSES = ['REGISTER', 'LOGIN', 'RESET'] as const;
/** ADR-015: ADMIN is never self-selected; it comes from ADMIN_EMAILS (or the demo seed). */
export const USER_ROLES = ['ADMIN', 'RECRUITER', 'INTERVIEWER'] as const;
export const SELF_SERVICE_ROLES = ['RECRUITER', 'INTERVIEWER'] as const;
