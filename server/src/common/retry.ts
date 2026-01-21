/**
 * Retry utility with exponential backoff for LLM and API calls.
 *
 * Features:
 * - Exponential backoff with jitter
 * - Error classification (retry vs no-retry)
 * - Configurable retry limits and timing
 * - Logging for observability
 */

import { RetryableError, ValidationError } from './exceptions.js';
import { REALM_CONFIG } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface RetryConfig {
  maxRetries: number;
  baseMultiplier: number; // seconds
  minWait: number; // seconds
  operationName?: string;
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Determines if an error is retryable based on error classification.
 *
 * Retry: RetryableError, HTTP 5xx, network errors, rate limits, timeouts
 * No retry: ValidationError, HTTP 4xx client errors, auth errors, quota errors
 */
function isRetryable(error: unknown): boolean {
  // Explicit error types
  if (error instanceof RetryableError) {
    return true;
  }
  if (error instanceof ValidationError) {
    return false;
  }

  const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorName = error instanceof Error ? error.name : '';

  // Check for non-retryable conditions first (fail fast)
  const nonRetryablePatterns = [
    // HTTP client errors
    'status 400', 'status: 400', 'bad request',
    'status 401', 'status: 401', 'unauthorized',
    'status 403', 'status: 403', 'forbidden',
    'status 404', 'status: 404', 'not found',
    'status 422', 'status: 422', 'unprocessable',
    // Auth and permission errors
    'authentication', 'invalid api key', 'api key invalid',
    'permission denied', 'access denied',
    // Quota and billing errors
    'quota exceeded', 'quota_exceeded', 'billing',
    'insufficient_quota', 'usage limit',
    // Invalid request errors
    'invalid request', 'invalid_request', 'malformed',
    'invalid argument', 'invalid_argument',
    // Content policy errors
    'content policy', 'safety', 'blocked',
    // Model errors
    'model not found', 'invalid model',
  ];

  for (const pattern of nonRetryablePatterns) {
    if (errorMessage.includes(pattern)) {
      return false;
    }
  }

  // Check for retryable conditions
  const retryablePatterns = [
    // Rate limiting
    'rate limit', 'rate_limit', 'ratelimit', 'too many requests', '429',
    // Timeouts
    'timeout', 'timed out', 'etimedout', 'deadline exceeded',
    // Network errors
    'econnreset', 'econnrefused', 'socket hang up', 'network error',
    'connection refused', 'connection reset', 'epipe', 'enotfound',
    // Server errors
    '500', '502', '503', '504',
    'internal server error', 'bad gateway', 'service unavailable', 'gateway timeout',
    // Capacity errors
    'overloaded', 'capacity', 'temporarily unavailable', 'try again',
    // Resource exhaustion
    'resource exhausted', 'resource_exhausted',
  ];

  for (const pattern of retryablePatterns) {
    if (errorMessage.includes(pattern)) {
      return true;
    }
  }

  // Check error name for common network errors
  const retryableErrorNames = [
    'AbortError',
    'TimeoutError',
    'NetworkError',
    'FetchError',
  ];
  if (retryableErrorNames.includes(errorName)) {
    return true;
  }

  // Default: do NOT retry unknown errors to avoid masking bugs
  // If an error should be retried, add it to the retryablePatterns list
  return false;
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Extracts a safe, non-sensitive error summary for logging.
 * Only logs error type/category, not potentially sensitive message content.
 */
function getSafeErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    // Only log the error name/type, not the full message which may contain sensitive data
    const errorType = error.name || 'Error';
    // Extract only generic error category indicators, not specific content
    const message = error.message.toLowerCase();
    if (message.includes('timeout')) return `${errorType}: timeout`;
    if (message.includes('rate limit') || message.includes('429')) return `${errorType}: rate_limit`;
    if (message.includes('network') || message.includes('econnrefused')) return `${errorType}: network_error`;
    if (message.includes('500') || message.includes('internal server')) return `${errorType}: server_error_5xx`;
    if (message.includes('401') || message.includes('unauthorized')) return `${errorType}: auth_error`;
    if (message.includes('403') || message.includes('forbidden')) return `${errorType}: forbidden`;
    if (message.includes('404')) return `${errorType}: not_found`;
    if (message.includes('400') || message.includes('bad request')) return `${errorType}: bad_request`;
    if (message.includes('quota')) return `${errorType}: quota_exceeded`;
    return errorType;
  }
  return 'UnknownError';
}

// ============================================================================
// Core Retry Logic
// ============================================================================

/**
 * Calculates wait time with exponential backoff and jitter.
 *
 * Formula: max(minWait, baseMultiplier * 2^attempt * (0.5 + random(0, 0.5)))
 */
function calculateWaitTime(attempt: number, config: RetryConfig): number {
  const exponentialWait = config.baseMultiplier * Math.pow(2, attempt);
  const jitter = 0.5 + Math.random() * 0.5; // 0.5 to 1.0
  const waitTime = exponentialWait * jitter;
  return Math.max(config.minWait, waitTime);
}

/**
 * Sleeps for the specified number of seconds.
 */
function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

/**
 * Generic retry wrapper with exponential backoff.
 *
 * @param operation - Async function to retry
 * @param config - Retry configuration
 * @returns Result of the operation
 * @throws Last error if all retries exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  const operationName = config.operationName || 'Operation';
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const errorSummary = getSafeErrorSummary(error);

      // Check if this error is retryable
      if (!isRetryable(error)) {
        console.log(`[Retry] ${operationName} failed with non-retryable error: ${errorSummary}`);
        throw lastError;
      }

      // If we've exhausted retries, throw
      if (attempt >= config.maxRetries) {
        console.log(`[Retry] ${operationName} exhausted all ${config.maxRetries} retries. Final error: ${errorSummary}`);
        throw lastError;
      }

      // Calculate wait time and log
      const waitTime = calculateWaitTime(attempt, config);
      console.log(
        `[Retry] ${operationName} attempt ${attempt + 1}/${config.maxRetries + 1} failed: ${errorSummary}. Retrying in ${waitTime.toFixed(1)}s...`
      );

      await sleep(waitTime);
    }
  }

  // TypeScript requires this for type safety, though loop always returns or throws
  throw lastError!;
}

// ============================================================================
// Pre-configured Retry Functions
// ============================================================================

/**
 * Retry wrapper for LLM calls (generous retries for expensive operations).
 *
 * Config: 8 retries, 10s base multiplier, 0.5s minimum wait
 */
export async function retryLLM<T>(
  operation: () => Promise<T>,
  options?: { operationName?: string }
): Promise<T> {
  return withRetry(operation, {
    ...REALM_CONFIG.retry.llm,
    operationName: options?.operationName,
  });
}

/**
 * Retry wrapper for API calls (moderate retries).
 *
 * Config: 3 retries, 5s base multiplier, 0.5s minimum wait
 */
export async function retryAPI<T>(
  operation: () => Promise<T>,
  options?: { operationName?: string }
): Promise<T> {
  return withRetry(operation, {
    ...REALM_CONFIG.retry.api,
    operationName: options?.operationName,
  });
}
