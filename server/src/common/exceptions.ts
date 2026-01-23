/**
 * Custom exception types for the CHR application.
 *
 * These exceptions enable proper error classification for retry logic:
 * - RetryableError: Transient failures that may succeed on retry
 * - ValidationError: Data/input errors that won't be fixed by retrying
 */

export class CHRError extends Error {
  constructor(
    message: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'CHRError';
    // Preserve the original stack trace if available
    if (originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

export class RetryableError extends CHRError {
  constructor(message: string, originalError?: Error) {
    super(message, originalError);
    this.name = 'RetryableError';
  }
}

export class ValidationError extends CHRError {
  constructor(message: string, originalError?: Error) {
    super(message, originalError);
    this.name = 'ValidationError';
  }
}
