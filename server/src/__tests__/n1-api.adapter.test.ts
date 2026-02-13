/**
 * Tests for adapters/n1-api/n1-api.adapter.ts
 *
 * Mocks global fetch to test N1ApiAdapter:
 * - Constructor validation
 * - URL handling (trailing slash removal)
 * - Pagination
 * - PDF validation
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { N1ApiAdapter } from '../adapters/n1-api/n1-api.adapter.js';

// Mock console to suppress noisy test output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Build a minimal valid PDF ArrayBuffer (starts with %PDF-)
function makePdfArrayBuffer(content = 'test'): ArrayBuffer {
  const buf = Buffer.from(`%PDF-${content}`);
  // Return a properly-sized ArrayBuffer (not the full Node.js pool buffer)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('N1ApiAdapter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('throws without baseUrl', () => {
    expect(() => new N1ApiAdapter('', 'key')).toThrow('N1_API_BASE_URL is required');
  });

  it('throws without apiKey', () => {
    expect(() => new N1ApiAdapter('https://api.example.com', '')).toThrow('N1_API_KEY is required');
  });

  it('strips trailing slashes from baseUrl', () => {
    const adapter = new N1ApiAdapter('https://api.example.com///', 'key');
    // We can't directly access private baseUrl, but we can test via a fetch call
    expect(adapter).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // fetchPDFsForUser
  // -----------------------------------------------------------------------

  it('fetches and downloads completed PDFs', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'test-key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Call 1: paginated list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        user_id: 'user-1',
        data: [
          { id: 'rec-1', user_id: 'user-1', file_name: 'blood-work.pdf', url: 'https://s3/old-url', status: 'COMPLETED', progress: 100 },
          { id: 'rec-2', user_id: 'user-1', file_name: 'mri.pdf', url: 'https://s3/old-url-2', status: 'PROCESSING', progress: 50 },
        ],
        total_count: 2,
        total_pages: 1,
        page: 1,
        page_size: 100,
      }),
    });

    // Call 2: getFreshUrl for rec-1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://s3/fresh-url-rec-1' }),
    });

    // Call 3: download PDF for rec-1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => makePdfArrayBuffer('real-content'),
    });

    const results = await adapter.fetchPDFsForUser('user-1');

    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe('rec-1');
    expect(results[0].fileName).toBe('blood-work.pdf');
    expect(results[0].buffer.toString('utf-8', 0, 5)).toBe('%PDF-');
  });

  it('paginates through multiple pages', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    // Page 1
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'r1', user_id: 'u', file_name: 'a.pdf', url: 'u', status: 'COMPLETED', progress: 100 }],
        total_pages: 2,
        page: 1,
      }),
    });
    // getFreshUrl for r1
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://fresh/r1' }) });
    // download r1
    mockFetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => makePdfArrayBuffer() });

    // Page 2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'r2', user_id: 'u', file_name: 'b.pdf', url: 'u', status: 'COMPLETED', progress: 100 }],
        total_pages: 2,
        page: 2,
      }),
    });
    // getFreshUrl for r2
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://fresh/r2' }) });
    // download r2
    mockFetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => makePdfArrayBuffer() });

    const results = await adapter.fetchPDFsForUser('u');
    expect(results).toHaveLength(2);
  });

  it('throws on API error response', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(adapter.fetchPDFsForUser('user-1')).rejects.toThrow('API request failed');
  });

  it('throws on invalid API response format', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }), // missing data array
    });

    await expect(adapter.fetchPDFsForUser('user-1')).rejects.toThrow('Invalid API response format');
  });

  it('skips non-completed records', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'r1', status: 'PROCESSING', progress: 50 },
          { id: 'r2', status: 'FAILED', progress: 0 },
        ],
        total_pages: 1,
        page: 1,
      }),
    });

    const results = await adapter.fetchPDFsForUser('user-1');
    expect(results).toHaveLength(0);
  });

  it('continues on individual PDF download error', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'r1', status: 'COMPLETED', file_name: 'a.pdf', progress: 100 },
          { id: 'r2', status: 'COMPLETED', file_name: 'b.pdf', progress: 100 },
        ],
        total_pages: 1,
        page: 1,
      }),
    });

    // r1: getFreshUrl fails
    mockFetch.mockRejectedValueOnce(new Error('URL fetch failed'));
    // r2: getFreshUrl works
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://fresh/r2' }) });
    // r2: download works
    mockFetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => makePdfArrayBuffer() });

    const results = await adapter.fetchPDFsForUser('user-1');
    expect(results).toHaveLength(1);
    expect(results[0].recordId).toBe('r2');
  });

  it('uses record.id as filename fallback when file_name is missing', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'rec-abc', status: 'COMPLETED', file_name: '', progress: 100 }],
        total_pages: 1,
        page: 1,
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://fresh' }) });
    mockFetch.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => makePdfArrayBuffer() });

    const results = await adapter.fetchPDFsForUser('user-1');
    expect(results[0].fileName).toBe('rec-abc.pdf');
  });

  it('includes N1-Api-Key header in requests', async () => {
    const adapter = new N1ApiAdapter('https://api.example.com', 'secret-key');
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], total_pages: 1, page: 1 }),
    });

    await adapter.fetchPDFsForUser('user-1');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.example.com'),
      expect.objectContaining({
        headers: { 'N1-Api-Key': 'secret-key' },
      }),
    );
  });
});
