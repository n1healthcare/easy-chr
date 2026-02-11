import { describe, it, expect } from 'vitest';
import { sanitizeLogMessage, sanitizeObjectValues } from '../utils/pii-sanitizer.js';

describe('sanitizeLogMessage', () => {
  it('redacts email addresses', () => {
    const result = sanitizeLogMessage('User john.doe@example.com logged in');
    expect(result).toContain('[REDACTED-EMAIL]');
    expect(result).not.toContain('john.doe');
  });

  it('redacts multiple emails', () => {
    const result = sanitizeLogMessage('Contact: alice@test.com or bob@example.org');
    expect(result.match(/\[REDACTED-EMAIL\]/g)?.length).toBe(2);
  });

  it('redacts phone numbers', () => {
    const result = sanitizeLogMessage('Contact: 555-123-4567');
    expect(result).toContain('[REDACTED-PHONE]');
    expect(result).not.toContain('555-123-4567');
  });

  it('redacts phone with area code', () => {
    const result = sanitizeLogMessage('Call (555) 123-4567 for help');
    expect(result).toContain('[REDACTED-PHONE]');
  });

  it('redacts SSN', () => {
    const result = sanitizeLogMessage('SSN: 123-45-6789');
    expect(result).toContain('[REDACTED-SSN]');
    expect(result).not.toContain('123-45-6789');
  });

  it('redacts names in JSON format', () => {
    const result = sanitizeLogMessage('{"first_name": "John", "last_name": "Smith"}');
    expect(result).not.toContain('John');
    expect(result).not.toContain('Smith');
  });

  it('redacts names in assignment format', () => {
    const result = sanitizeLogMessage('patient_name=Jane Doe, status=active');
    expect(result).not.toContain('Jane');
    expect(result).toContain('[REDACTED-NAME]');
    expect(result).toContain('status=active');
  });

  it('preserves medical text with patient', () => {
    const msg = 'The patient has been suffering from insomnia for 3 months';
    expect(sanitizeLogMessage(msg)).toBe(msg);
  });

  it('preserves patient data term', () => {
    const msg = 'Loading patient data from database';
    expect(sanitizeLogMessage(msg)).toBe(msg);
  });

  it('preserves normal medical text', () => {
    const msg = 'Blood glucose: 95 mg/dL. The patient shows improvement.';
    expect(sanitizeLogMessage(msg)).toBe(msg);
  });

  it('handles empty string', () => {
    expect(sanitizeLogMessage('')).toBe('');
  });

  it('handles null/undefined', () => {
    expect(sanitizeLogMessage(null as unknown as string)).toBeNull();
    expect(sanitizeLogMessage(undefined as unknown as string)).toBeUndefined();
  });
});

describe('sanitizeObjectValues', () => {
  it('redacts email values', () => {
    const result = sanitizeObjectValues({ email: 'test@test.com', status: 'active' });
    expect(result.email).toBe('[REDACTED-EMAIL]');
    expect(result.status).toBe('active');
  });

  it('redacts name keys', () => {
    const result = sanitizeObjectValues({
      first_name: 'John',
      last_name: 'Smith',
      diagnosis: 'hypertension',
    });
    expect(result.first_name).toBe('[REDACTED]');
    expect(result.last_name).toBe('[REDACTED]');
    expect(result.diagnosis).toBe('hypertension');
  });

  it('handles nested objects', () => {
    const result = sanitizeObjectValues({ user: { email: 'test@test.com', id: 123 } });
    expect((result.user as Record<string, unknown>).email).toBe('[REDACTED-EMAIL]');
    expect((result.user as Record<string, unknown>).id).toBe(123);
  });

  it('preserves non-string values', () => {
    const result = sanitizeObjectValues({ count: 42, active: true, ratio: 3.14 });
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.ratio).toBe(3.14);
  });
});
