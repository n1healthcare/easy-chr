/**
 * Tests for common/exceptions.ts
 *
 * Tests CHRError, RetryableError, and ValidationError class behavior.
 */

import { describe, it, expect } from 'vitest';
import { CHRError, RetryableError, ValidationError } from '../common/exceptions.js';

// ============================================================================
// CHRError
// ============================================================================

describe('CHRError', () => {
  it('sets message correctly', () => {
    const err = new CHRError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('sets name to CHRError', () => {
    const err = new CHRError('test');
    expect(err.name).toBe('CHRError');
  });

  it('is an instance of Error', () => {
    const err = new CHRError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores originalError when provided', () => {
    const original = new Error('root cause');
    const err = new CHRError('wrapper', original);
    expect(err.originalError).toBe(original);
  });

  it('has undefined originalError when not provided', () => {
    const err = new CHRError('test');
    expect(err.originalError).toBeUndefined();
  });

  it('appends original stack trace to its own stack', () => {
    const original = new Error('root cause');
    const err = new CHRError('wrapper', original);
    expect(err.stack).toContain('Caused by:');
    expect(err.stack).toContain('root cause');
  });

  it('has a normal stack trace when no originalError', () => {
    const err = new CHRError('test');
    expect(err.stack).toBeDefined();
    expect(err.stack).not.toContain('Caused by:');
  });
});

// ============================================================================
// RetryableError
// ============================================================================

describe('RetryableError', () => {
  it('sets message correctly', () => {
    const err = new RetryableError('transient failure');
    expect(err.message).toBe('transient failure');
  });

  it('sets name to RetryableError', () => {
    const err = new RetryableError('test');
    expect(err.name).toBe('RetryableError');
  });

  it('is an instance of CHRError', () => {
    const err = new RetryableError('test');
    expect(err).toBeInstanceOf(CHRError);
  });

  it('is an instance of Error', () => {
    const err = new RetryableError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores originalError when provided', () => {
    const original = new Error('network timeout');
    const err = new RetryableError('retry this', original);
    expect(err.originalError).toBe(original);
  });

  it('appends original stack trace', () => {
    const original = new Error('connection reset');
    const err = new RetryableError('retry', original);
    expect(err.stack).toContain('Caused by:');
  });
});

// ============================================================================
// ValidationError
// ============================================================================

describe('ValidationError', () => {
  it('sets message correctly', () => {
    const err = new ValidationError('invalid input');
    expect(err.message).toBe('invalid input');
  });

  it('sets name to ValidationError', () => {
    const err = new ValidationError('test');
    expect(err.name).toBe('ValidationError');
  });

  it('is an instance of CHRError', () => {
    const err = new ValidationError('test');
    expect(err).toBeInstanceOf(CHRError);
  });

  it('is an instance of Error', () => {
    const err = new ValidationError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores originalError when provided', () => {
    const original = new Error('parse error');
    const err = new ValidationError('bad data', original);
    expect(err.originalError).toBe(original);
  });

  it('appends original stack trace', () => {
    const original = new Error('json parse failed');
    const err = new ValidationError('validation', original);
    expect(err.stack).toContain('Caused by:');
  });
});

// ============================================================================
// Error hierarchy and instanceof checks
// ============================================================================

describe('Error hierarchy', () => {
  it('RetryableError is NOT a ValidationError', () => {
    const err = new RetryableError('test');
    expect(err).not.toBeInstanceOf(ValidationError);
  });

  it('ValidationError is NOT a RetryableError', () => {
    const err = new ValidationError('test');
    expect(err).not.toBeInstanceOf(RetryableError);
  });

  it('can be caught as Error in try/catch', () => {
    let caught: Error | null = null;
    try {
      throw new RetryableError('test');
    } catch (e) {
      if (e instanceof Error) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toBe('test');
  });

  it('can be distinguished by name property', () => {
    const chr = new CHRError('a');
    const retry = new RetryableError('b');
    const validation = new ValidationError('c');

    expect(chr.name).toBe('CHRError');
    expect(retry.name).toBe('RetryableError');
    expect(validation.name).toBe('ValidationError');
  });
});
