/**
 * Tests for utils/genai-factory.ts
 *
 * Verifies createGoogleGenAI factory:
 * - Throws without GEMINI_API_KEY
 * - Creates client with API key
 * - Passes billing headers when context provided
 * - Includes baseURL when env var set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock GoogleGenAI constructor to capture config
const mockConstructor = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(config: unknown) {
      mockConstructor(config);
    }
  },
}));

// Import AFTER mock is set up
import { createGoogleGenAI } from '../utils/genai-factory.js';

describe('createGoogleGenAI', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockConstructor.mockClear();
    // Reset env
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when GEMINI_API_KEY is not set', () => {
    expect(() => createGoogleGenAI()).toThrow('GEMINI_API_KEY environment variable is required');
  });

  it('creates client with API key', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    createGoogleGenAI();
    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-key' })
    );
  });

  it('includes baseURL when GOOGLE_GEMINI_BASE_URL is set', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://proxy.example.com';
    createGoogleGenAI();
    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://proxy.example.com' })
    );
  });

  it('omits baseURL when GOOGLE_GEMINI_BASE_URL is not set', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    createGoogleGenAI();
    const config = mockConstructor.mock.calls[0][0];
    expect(config).not.toHaveProperty('baseURL');
  });

  it('includes billing headers when billingContext is provided', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    createGoogleGenAI({ userId: 'user-123', chrId: 'chr-456' });
    const config = mockConstructor.mock.calls[0][0];
    expect(config.httpOptions.headers).toEqual({
      'x-subject-user-id': 'user-123',
      'x-service-name': 'workflow-easy-chr',
      'x-chr-id': 'chr-456',
    });
  });

  it('omits httpOptions when no billingContext', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    createGoogleGenAI();
    const config = mockConstructor.mock.calls[0][0];
    expect(config).not.toHaveProperty('httpOptions');
  });

  it('includes minimal billing headers when only userId is provided', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // BillingContext always has userId, so headers always have at least that
    createGoogleGenAI({ userId: 'user-1' });
    const config = mockConstructor.mock.calls[0][0];
    expect(config.httpOptions.headers).toHaveProperty('x-subject-user-id', 'user-1');
  });
});
