export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  OTP_INVALID: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  EMAIL_TAKEN: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Request validation failed',
  INVALID_JSON: 'Malformed JSON body',
  OTP_INVALID: 'Invalid or expired verification code',
  UNAUTHENTICATED: 'Authentication required',
  INVALID_CREDENTIALS: 'Invalid email or password',
  FORBIDDEN: 'You do not have permission to perform this action',
  ORIGIN_NOT_ALLOWED: 'Request origin not allowed',
  NOT_FOUND: 'Resource not found',
  VERSION_CONFLICT: 'This record was changed by someone else. Reload and try again.',
  INVALID_TRANSITION: 'This status change is not allowed',
  EMAIL_TAKEN: 'An account with this email already exists',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  RATE_LIMITED: 'Too many requests. Try again later.',
  INTERNAL_ERROR: 'Something went wrong',
};

export interface ErrorDetail {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}
