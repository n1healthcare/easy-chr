/**
 * Tests for common/retry.ts
 *
 * Tests error classification (isRetryable), backoff calculation,
 * and the withRetry loop behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We cannot directly import isRetryable and calculateWaitTime because they are
// not exported (private functions). We test them indirectly through withRetry,
// plus we re-export the error classes that feed into isRetryable.
import { RetryableError, ValidationError, CHRError } from '../common/exceptions.js';
import { withRetry } from '../common/retry.js';

// ============================================================================
// isRetryable — tested indirectly via withRetry behavior
// ============================================================================

describe('Error classification via withRetry', () => {
  const fastConfig = {
    maxRetries: 1,
    baseMultiplier: 0.001, // near-instant for tests
    minWait: 0.001,
    operationName: 'test',
  };

  it('retries on RetryableError', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new RetryableError('transient failure');
      return 'success';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('success');
    expect(calls).toBe(2);
  });

  it('does NOT retry on ValidationError', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new ValidationError('bad input');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('bad input');
    expect(calls).toBe(1);
  });

  it('retries on rate limit errors (429)', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('status 429 too many requests');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on timeout errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('Request timed out');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on network errors (econnreset)', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('socket econnreset');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on server 500 errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('internal server error 500');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on 503 service unavailable', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('503 service unavailable');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does NOT retry on 400 bad request', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('status 400 bad request');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('status 400');
    expect(calls).toBe(1);
  });

  it('does NOT retry on 401 unauthorized', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('status 401 unauthorized');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  it('does NOT retry on invalid api key', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('Invalid API key provided');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('Invalid API key');
    expect(calls).toBe(1);
  });

  it('does NOT retry on quota exceeded', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('quota exceeded for this billing period');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('quota exceeded');
    expect(calls).toBe(1);
  });

  it('does NOT retry on budget errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('Exceeded budget for this request');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('Exceeded budget');
    expect(calls).toBe(1);
  });

  it('does NOT retry on content policy errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('Content blocked by safety filter');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('blocked');
    expect(calls).toBe(1);
  });

  it('does NOT retry unknown errors (default)', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('something completely unexpected happened');
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('something completely');
    expect(calls).toBe(1);
  });

  it('retries on AbortError by name', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('abort');
        err.name = 'AbortError';
        throw err;
      }
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on fetch failed network errors', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries when statusCode is 503 even if message is generic', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('upload failed');
        (err as Error & { statusCode?: number }).statusCode = 503;
        throw err;
      }
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on retryable SDK error code (SlowDown)', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('request failed');
        (err as Error & { code?: string }).code = 'SlowDown';
        throw err;
      }
      return 'ok';
    };
    const result = await withRetry(op, fastConfig);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does NOT retry on non-retryable SDK error code (AccessDenied)', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      const err = new Error('request failed');
      (err as Error & { code?: string }).code = 'AccessDenied';
      throw err;
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('request failed');
    expect(calls).toBe(1);
  });

  it('does NOT retry when structured status is 404', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      const err = new Error('request failed');
      (err as Error & { status?: number }).status = 404;
      throw err;
    };
    await expect(withRetry(op, fastConfig)).rejects.toThrow('request failed');
    expect(calls).toBe(1);
  });
});

// ============================================================================
// withRetry — loop behavior
// ============================================================================

describe('withRetry loop behavior', () => {
  it('returns on first success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 42;
      },
      { maxRetries: 3, baseMultiplier: 0.001, minWait: 0.001 },
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('exhausts all retries then throws', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new Error('rate limit hit');
    };
    await expect(
      withRetry(op, { maxRetries: 2, baseMultiplier: 0.001, minWait: 0.001, operationName: 'test' }),
    ).rejects.toThrow('rate limit');
    // 1 initial + 2 retries = 3 total calls
    expect(calls).toBe(3);
  });

  it('converts non-Error throws to Error', async () => {
    const op = async () => {
      throw 'string error';
    };
    await expect(
      withRetry(op, { maxRetries: 0, baseMultiplier: 0.001, minWait: 0.001 }),
    ).rejects.toThrow('string error');
  });

  it('succeeds after intermittent failures', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls <= 2) throw new Error('503 service unavailable');
      return 'recovered';
    };
    const result = await withRetry(op, {
      maxRetries: 3,
      baseMultiplier: 0.001,
      minWait: 0.001,
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });
});
