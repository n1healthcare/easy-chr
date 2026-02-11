/**
 * Tests for utils/billing.ts
 *
 * Tests createBillingHeaders — pure function, no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { createBillingHeaders, type BillingContext } from '../utils/billing.js';

// ============================================================================
// createBillingHeaders
// ============================================================================

describe('createBillingHeaders', () => {
  it('includes x-subject-user-id from context', () => {
    const headers = createBillingHeaders({ userId: 'user-123' });
    expect(headers['x-subject-user-id']).toBe('user-123');
  });

  it('includes x-service-name as workflow-easy-chr', () => {
    const headers = createBillingHeaders({ userId: 'user-123' });
    expect(headers['x-service-name']).toBe('workflow-easy-chr');
  });

  it('includes x-chr-id when chrId is provided', () => {
    const headers = createBillingHeaders({ userId: 'user-123', chrId: 'chr-456' });
    expect(headers['x-chr-id']).toBe('chr-456');
  });

  it('does NOT include x-chr-id when chrId is undefined', () => {
    const headers = createBillingHeaders({ userId: 'user-123' });
    expect(headers).not.toHaveProperty('x-chr-id');
  });

  it('does NOT include x-chr-id when chrId is empty string', () => {
    const headers = createBillingHeaders({ userId: 'user-123', chrId: '' });
    // Empty string is falsy, so spread with && will not include it
    expect(headers).not.toHaveProperty('x-chr-id');
  });

  it('returns exactly 2 headers without chrId', () => {
    const headers = createBillingHeaders({ userId: 'user-123' });
    expect(Object.keys(headers).length).toBe(2);
  });

  it('returns exactly 3 headers with chrId', () => {
    const headers = createBillingHeaders({ userId: 'user-123', chrId: 'chr-456' });
    expect(Object.keys(headers).length).toBe(3);
  });

  it('uses the exact userId value without transformation', () => {
    const headers = createBillingHeaders({ userId: 'AbC-123_xyz' });
    expect(headers['x-subject-user-id']).toBe('AbC-123_xyz');
  });

  it('handles special characters in userId', () => {
    const headers = createBillingHeaders({ userId: 'user@example.com' });
    expect(headers['x-subject-user-id']).toBe('user@example.com');
  });

  it('handles special characters in chrId', () => {
    const headers = createBillingHeaders({
      userId: 'user-1',
      chrId: 'chr/report#2024',
    });
    expect(headers['x-chr-id']).toBe('chr/report#2024');
  });
});
