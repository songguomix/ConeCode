export type ErrorCode =
  | 'PROTOCOL_INVALID'
  | 'INVALID_TRANSITION'
  | 'TASK_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'BUDGET_EXCEEDED'
  | 'CANCELLED'
  | 'PAUSED'
  | 'AUTHORIZATION_DENIED'
  | 'TARGET_STALE'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_ACTIONABLE'
  | 'OBSERVATION_STALE'
  | 'DRIVER_UNAVAILABLE'
  | 'DRIVER_ERROR'
  | 'MODEL_ERROR'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_CAPABILITY_MISSING'
  | 'VERIFICATION_FAILED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNKNOWN_OUTCOME'
  | 'LEASE_LOST'
  | 'APPROVAL_REQUIRED'
  | 'CODE_TIMEOUT'
  | 'CODE_SANDBOX_UNAVAILABLE'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'INTERNAL';

export class CuaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly sideEffectMayHaveHappened: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      sideEffectMayHaveHappened?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CuaError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.sideEffectMayHaveHappened = options.sideEffectMayHaveHappened ?? false;
  }
}

export class InvalidTransitionError extends CuaError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSITION', `Task state cannot move from "${from}" to "${to}".`, {
      details: { from, to },
    });
    this.name = 'InvalidTransitionError';
  }
}

export function isCuaError(error: unknown): error is CuaError {
  return error instanceof CuaError;
}

export function toCuaError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL'): CuaError {
  if (isCuaError(error)) return error;
  if (error instanceof Error) {
    return new CuaError(fallbackCode, error.message, { cause: error });
  }
  return new CuaError(fallbackCode, String(error));
}

/** Convert an error into the stable wire shape used by every interface. */
export function serializeError(error: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  sideEffectMayHaveHappened: boolean;
  details?: Record<string, unknown>;
} {
  const e = toCuaError(error);
  return {
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    sideEffectMayHaveHappened: e.sideEffectMayHaveHappened,
    ...(e.details ? { details: e.details } : {}),
  };
}
