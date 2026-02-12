/**
 * Tests for PrefixedStorageAdapter
 *
 * Verifies path safety, prefix application, double-slash collapsing,
 * empty prefix pass-through, and that all methods forward correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrefixedStorageAdapter } from '../adapters/storage/prefixed-storage.adapter.js';
import type { StoragePort } from '../application/ports/storage.port.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(): Record<keyof StoragePort, ReturnType<typeof vi.fn>> {
  return {
    writeFile: vi.fn().mockResolvedValue('written-path'),
    readFile: vi.fn().mockResolvedValue(Buffer.from('data')),
    readFileAsString: vi.fn().mockResolvedValue('string-data'),
    appendFile: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    fileExists: vi.fn().mockResolvedValue({ exists: true }),
    createWriteStream: vi.fn().mockResolvedValue({ write: vi.fn() }),
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.url'),
    deleteFile: vi.fn().mockResolvedValue(true),
    listFiles: vi.fn().mockResolvedValue(['a.txt']),
  };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe('PrefixedStorageAdapter — path safety', () => {
  let adapter: PrefixedStorageAdapter;

  beforeEach(() => {
    const inner = createMockStorage();
    adapter = new PrefixedStorageAdapter(inner as unknown as StoragePort, 'prefix');
  });

  it('throws on path traversal with ".."', async () => {
    await expect(adapter.readFile('../etc/passwd')).rejects.toThrow('Path traversal');
    await expect(adapter.writeFile('foo/../bar', 'x')).rejects.toThrow('Path traversal');
  });

  it('throws on absolute paths starting with "/"', async () => {
    await expect(adapter.readFile('/etc/passwd')).rejects.toThrow('Absolute paths');
    await expect(adapter.writeFile('/root/file', 'x')).rejects.toThrow('Absolute paths');
  });
});

// ---------------------------------------------------------------------------
// Prefix application
// ---------------------------------------------------------------------------

describe('PrefixedStorageAdapter — prefix application', () => {
  it('prepends prefix to path', async () => {
    const inner = createMockStorage();
    const adapter = new PrefixedStorageAdapter(inner as unknown as StoragePort, 'users/123');

    await adapter.writeFile('foo.txt', 'content');
    expect(inner.writeFile).toHaveBeenCalledWith('users/123/foo.txt', 'content', undefined);
  });

  it('collapses double slashes when prefix has trailing slash', async () => {
    const inner = createMockStorage();
    const adapter = new PrefixedStorageAdapter(inner as unknown as StoragePort, 'users/123/');

    await adapter.writeFile('foo.txt', 'content');
    expect(inner.writeFile).toHaveBeenCalledWith('users/123/foo.txt', 'content', undefined);
  });
});

// ---------------------------------------------------------------------------
// Empty prefix
// ---------------------------------------------------------------------------

describe('PrefixedStorageAdapter — empty prefix', () => {
  it('returns path unchanged when prefix is empty', async () => {
    const inner = createMockStorage();
    const adapter = new PrefixedStorageAdapter(inner as unknown as StoragePort, '');

    await adapter.readFile('foo.txt');
    expect(inner.readFile).toHaveBeenCalledWith('foo.txt');
  });
});

// ---------------------------------------------------------------------------
// All methods apply prefix and forward return values
// ---------------------------------------------------------------------------

describe('PrefixedStorageAdapter — all methods apply prefix', () => {
  let inner: ReturnType<typeof createMockStorage>;
  let adapter: PrefixedStorageAdapter;

  beforeEach(() => {
    inner = createMockStorage();
    adapter = new PrefixedStorageAdapter(inner as unknown as StoragePort, 'pfx');
  });

  it('writeFile', async () => {
    const result = await adapter.writeFile('f.txt', 'data', 'text/plain');
    expect(inner.writeFile).toHaveBeenCalledWith('pfx/f.txt', 'data', 'text/plain');
    expect(result).toBe('written-path');
  });

  it('readFile', async () => {
    const result = await adapter.readFile('f.txt');
    expect(inner.readFile).toHaveBeenCalledWith('pfx/f.txt');
    expect(result).toEqual(Buffer.from('data'));
  });

  it('readFileAsString', async () => {
    const result = await adapter.readFileAsString('f.txt', 'utf-8');
    expect(inner.readFileAsString).toHaveBeenCalledWith('pfx/f.txt', 'utf-8');
    expect(result).toBe('string-data');
  });

  it('appendFile', async () => {
    await adapter.appendFile('f.txt', 'more');
    expect(inner.appendFile).toHaveBeenCalledWith('pfx/f.txt', 'more');
  });

  it('ensureDir', async () => {
    await adapter.ensureDir('sub');
    expect(inner.ensureDir).toHaveBeenCalledWith('pfx/sub');
  });

  it('exists', async () => {
    const result = await adapter.exists('f.txt');
    expect(inner.exists).toHaveBeenCalledWith('pfx/f.txt');
    expect(result).toBe(true);
  });

  it('fileExists', async () => {
    const result = await adapter.fileExists('f.txt');
    expect(inner.fileExists).toHaveBeenCalledWith('pfx/f.txt');
    expect(result).toEqual({ exists: true });
  });

  it('createWriteStream', async () => {
    await adapter.createWriteStream('f.bin', 'application/octet-stream');
    expect(inner.createWriteStream).toHaveBeenCalledWith('pfx/f.bin', 'application/octet-stream');
  });

  it('getSignedUrl', async () => {
    const opts = { expirationHours: 1 };
    const result = await adapter.getSignedUrl('f.pdf', opts);
    expect(inner.getSignedUrl).toHaveBeenCalledWith('pfx/f.pdf', opts);
    expect(result).toBe('https://signed.url');
  });

  it('deleteFile', async () => {
    const result = await adapter.deleteFile('f.txt');
    expect(inner.deleteFile).toHaveBeenCalledWith('pfx/f.txt');
    expect(result).toBe(true);
  });

  it('listFiles', async () => {
    const result = await adapter.listFiles('dir/');
    expect(inner.listFiles).toHaveBeenCalledWith('pfx/dir/');
    expect(result).toEqual(['a.txt']);
  });
});
