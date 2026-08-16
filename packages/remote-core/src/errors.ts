/**
 * Stable error vocabulary shared by the dsh-remote daemon frontend and
 * backend. Every failure crossing the wire (or the process boundary) is
 * normalized to a {@link RemoteError} carrying one of these codes, so callers
 * can branch on `code` instead of matching message text.
 */

/** Stable machine-readable error codes for dsh-remote daemon operations. */
export type RemoteErrorCode =
  | 'REMOTE_CONN_LOST'
  | 'REMOTE_AUTH_FAILED'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_NOT_BOOTSTRAPPED'
  | 'REMOTE_SESSION_LOCKED'
  | 'REMOTE_PROTOCOL_ERROR'
  | 'REMOTE_ABORTED';

const REMOTE_ERROR_CODES: readonly RemoteErrorCode[] = [
  'REMOTE_CONN_LOST',
  'REMOTE_AUTH_FAILED',
  'REMOTE_TIMEOUT',
  'REMOTE_NOT_BOOTSTRAPPED',
  'REMOTE_SESSION_LOCKED',
  'REMOTE_PROTOCOL_ERROR',
  'REMOTE_ABORTED',
];

/** Type guard for the {@link RemoteErrorCode} vocabulary. */
export function isRemoteErrorCode(value: unknown): value is RemoteErrorCode {
  return typeof value === 'string' && (REMOTE_ERROR_CODES as readonly string[]).includes(value);
}

/** Options accepted by the {@link RemoteError} constructor. */
export interface RemoteErrorOptions {
  /** Original exception that caused this error, if any. */
  cause?: unknown;
  /** Structured details attached to the error (e.g. lock holder for REMOTE_SESSION_LOCKED). */
  data?: unknown;
}

/** An error with a stable machine-readable {@link RemoteError.code}. */
export class RemoteError extends Error {
  override readonly name: string = 'RemoteError';

  /** Stable machine-readable code; safe for programmatic branching. */
  readonly code: RemoteErrorCode;

  /** Optional structured details propagated alongside the code. */
  readonly data?: unknown;

  constructor(code: RemoteErrorCode, message: string, options?: RemoteErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.data = options?.data;
  }
}

/**
 * Normalize an arbitrary thrown value into a {@link RemoteError}. Existing
 * RemoteErrors pass through untouched; anything else is wrapped with
 * `fallbackCode`, preserving the original value as `cause`.
 */
export function toRemoteError(err: unknown, fallbackCode: RemoteErrorCode): RemoteError {
  if (err instanceof RemoteError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RemoteError(fallbackCode, message, { cause: err });
}
