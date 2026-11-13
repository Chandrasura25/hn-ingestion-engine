/**
 * Error taxonomy. Every failure is classified so the queue knows whether to
 * retry (transient), pause the queue (rate limited) or give up (permanent → DLQ).
 */
export type ErrorClass =
  | 'rate_limited'
  | 'transient'
  | 'not_found'
  | 'invalid_payload'
  | 'permanent'
  | 'internal';

export abstract class SourceError extends Error {
  abstract readonly retryable: boolean;
  abstract readonly errorClass: ErrorClass;
}

export class RateLimitedError extends SourceError {
  readonly retryable = true;
  readonly errorClass = 'rate_limited' as const;
  constructor(
    readonly retryAfterMs: number,
    message = 'upstream rate limited',
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** Timeouts, 5xx, connection resets, truncated bodies. Worth retrying. */
export class TransientSourceError extends SourceError {
  readonly retryable = true;
  readonly errorClass = 'transient' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TransientSourceError';
  }
}

export class NotFoundError extends SourceError {
  readonly retryable = false;
  readonly errorClass = 'not_found' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Upstream answered, but with something we can't safely store. */
export class InvalidPayloadError extends SourceError {
  readonly retryable = false;
  readonly errorClass = 'invalid_payload' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

export class PermanentSourceError extends SourceError {
  readonly retryable = false;
  readonly errorClass = 'permanent' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSourceError';
  }
}

/** Unknown errors (DB blips, bugs) are retried: losing data is worse than a wasted retry. */
export function isRetryable(err: unknown): boolean {
  return err instanceof SourceError ? err.retryable : true;
}

export function classify(err: unknown): ErrorClass {
  return err instanceof SourceError ? err.errorClass : 'internal';
}
