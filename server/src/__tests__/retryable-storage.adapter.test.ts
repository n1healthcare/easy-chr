/**
 * Tests for RetryableStorageAdapter
 *
 * Verifies that every StoragePort method delegates to the inner adapter
 * and that retry behavior (via withRetry) is applied to all methods
 * except createWriteStream.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryableStorageAdapter } from '../adapters/storage/retryable-storage.adapter.js';
import { RetryableError, ValidationError } from '../common/exceptions.js';
import type { StoragePort } from '../application/ports/storage.port.js';
import type { RetryConfig } from '../common/retry.js';

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
    fileExists: vi.fn().mockResolvedValue({ exists: true, lastModified: new Date() }),
    createWriteStream: vi.fn().mockResolvedValue({ write: vi.fn() }),
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.url'),
    deleteFile: vi.fn().mockResolvedValue(true),
    listFiles: vi.fn().mockResolvedValue(['a.txt', 'b.txt']),
  };
}

const fastConfig: RetryConfig = {
  maxRetries: 2,
  baseMultiplier: 0.001,
  minWait: 0.001,
  operationName: 'test',
};

// ---------------------------------------------------------------------------
// Delegation — each method calls inner with correct args
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — delegation', () => {
  let inner: ReturnType<typeof createMockStorage>;
  let adapter: RetryableStorageAdapter;

  beforeEach(() => {
    inner = createMockStorage();
    adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);
  });

  it('writeFile passes path, content, contentType', async () => {
    await adapter.writeFile('dir/file.txt', 'hello', 'text/plain');
    expect(inner.writeFile).toHaveBeenCalledWith('dir/file.txt', 'hello', 'text/plain');
  });

  it('readFile passes path', async () => {
    await adapter.readFile('dir/file.txt');
    expect(inner.readFile).toHaveBeenCalledWith('dir/file.txt');
  });

  it('readFileAsString passes path and encoding', async () => {
    await adapter.readFileAsString('dir/file.txt', 'utf-8');
    expect(inner.readFileAsString).toHaveBeenCalledWith('dir/file.txt', 'utf-8');
  });

  it('appendFile passes path and content', async () => {
    await adapter.appendFile('dir/file.txt', 'appended');
    expect(inner.appendFile).toHaveBeenCalledWith('dir/file.txt', 'appended');
  });

  it('ensureDir passes path', async () => {
    await adapter.ensureDir('dir/sub');
    expect(inner.ensureDir).toHaveBeenCalledWith('dir/sub');
  });

  it('exists passes path', async () => {
    await adapter.exists('dir/file.txt');
    expect(inner.exists).toHaveBeenCalledWith('dir/file.txt');
  });

  it('fileExists passes path', async () => {
    await adapter.fileExists('dir/file.txt');
    expect(inner.fileExists).toHaveBeenCalledWith('dir/file.txt');
  });

  it('getSignedUrl passes path and options', async () => {
    const opts = { expirationHours: 2, contentType: 'application/pdf' };
    await adapter.getSignedUrl('dir/file.pdf', opts);
    expect(inner.getSignedUrl).toHaveBeenCalledWith('dir/file.pdf', opts);
  });

  it('deleteFile passes path', async () => {
    await adapter.deleteFile('dir/file.txt');
    expect(inner.deleteFile).toHaveBeenCalledWith('dir/file.txt');
  });

  it('listFiles passes prefix', async () => {
    await adapter.listFiles('dir/');
    expect(inner.listFiles).toHaveBeenCalledWith('dir/');
  });

  it('createWriteStream passes path and contentType', async () => {
    await adapter.createWriteStream('dir/file.bin', 'application/octet-stream');
    expect(inner.createWriteStream).toHaveBeenCalledWith('dir/file.bin', 'application/octet-stream');
  });

  it('forwards return values from inner', async () => {
    expect(await adapter.writeFile('p', 'c')).toBe('written-path');
    expect(await adapter.readFileAsString('p')).toBe('string-data');
    expect(await adapter.exists('p')).toBe(true);
    expect(await adapter.getSignedUrl('p')).toBe('https://signed.url');
    expect(await adapter.deleteFile('p')).toBe(true);
    expect(await adapter.listFiles('p')).toEqual(['a.txt', 'b.txt']);
  });
});

// ---------------------------------------------------------------------------
// createWriteStream is NOT retried
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — createWriteStream (no retry)', () => {
  it('throws immediately on failure without retrying', async () => {
    const inner = createMockStorage();
    inner.createWriteStream.mockRejectedValue(new Error('stream open failed'));
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    await expect(adapter.createWriteStream('file.bin')).rejects.toThrow('stream open failed');
    expect(inner.createWriteStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Retry on transient errors
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — retry on transient errors', () => {
  it('retries on RetryableError and returns success', async () => {
    const inner = createMockStorage();
    let calls = 0;
    inner.writeFile.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new RetryableError('transient S3 failure');
      return 'ok';
    });
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    const result = await adapter.writeFile('path', 'content');
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('retries on network errors (econnreset)', async () => {
    const inner = createMockStorage();
    let calls = 0;
    inner.readFile.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('socket econnreset');
      return Buffer.from('data');
    });
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    const result = await adapter.readFile('path');
    expect(result).toEqual(Buffer.from('data'));
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Non-retryable errors fail immediately
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — non-retryable errors fail immediately', () => {
  it('does not retry on ValidationError', async () => {
    const inner = createMockStorage();
    let calls = 0;
    inner.exists.mockImplementation(async () => {
      calls++;
      throw new ValidationError('bad input');
    });
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    await expect(adapter.exists('path')).rejects.toThrow('bad input');
    expect(calls).toBe(1);
  });

  it('does not retry on 401 unauthorized', async () => {
    const inner = createMockStorage();
    let calls = 0;
    inner.readFileAsString.mockImplementation(async () => {
      calls++;
      throw new Error('status 401 unauthorized');
    });
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    await expect(adapter.readFileAsString('path')).rejects.toThrow('401');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Exhausted retries
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — exhausted retries', () => {
  it('throws after maxRetries+1 attempts', async () => {
    const inner = createMockStorage();
    let calls = 0;
    inner.deleteFile.mockImplementation(async () => {
      calls++;
      throw new RetryableError('always fails');
    });
    const adapter = new RetryableStorageAdapter(inner as unknown as StoragePort, fastConfig);

    await expect(adapter.deleteFile('path')).rejects.toThrow('always fails');
    // 1 initial + 2 retries = 3
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// operationName is set per method
// ---------------------------------------------------------------------------

describe('RetryableStorageAdapter — operationName per method', () => {
  // We verify operationName indirectly: when an operation exhausts retries,
  // the console.log output from withRetry includes the operationName.
  // We spy on console.log and check the emitted string.

  const methods: Array<{
    name: keyof StoragePort;
    args: unknown[];
    expectedOp: string;
  }> = [
    { name: 'writeFile', args: ['p', 'c'], expectedOp: 'Storage.writeFile' },
    { name: 'readFile', args: ['p'], expectedOp: 'Storage.readFile' },
    { name: 'readFileAsString', args: ['p'], expectedOp: 'Storage.readFileAsString' },
    { name: 'appendFile', args: ['p', 'c'], expectedOp: 'Storage.appendFile' },
    { name: 'ensureDir', args: ['p'], expectedOp: 'Storage.ensureDir' },
    { name: 'exists', args: ['p'], expectedOp: 'Storage.exists' },
    { name: 'fileExists', args: ['p'], expectedOp: 'Storage.fileExists' },
    { name: 'getSignedUrl', args: ['p'], expectedOp: 'Storage.getSignedUrl' },
    { name: 'deleteFile', args: ['p'], expectedOp: 'Storage.deleteFile' },
    { name: 'listFiles', args: ['p'], expectedOp: 'Storage.listFiles' },
  ];

  for (const { name, args, expectedOp } of methods) {
    it(`${name} uses operationName "${expectedOp}"`, async () => {
      const inner = createMockStorage();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      (inner[name] as ReturnType<typeof vi.fn>).mockRejectedValue(
        new RetryableError('transient')
      );

      const adapter = new RetryableStorageAdapter(
        inner as unknown as StoragePort,
        { maxRetries: 0, baseMultiplier: 0.001, minWait: 0.001 },
      );

      await expect((adapter[name] as Function)(...args)).rejects.toThrow('transient');

      const logMessages = logSpy.mock.calls.map(c => c[0]);
      expect(logMessages.some((msg: string) => msg.includes(expectedOp))).toBe(true);

      logSpy.mockRestore();
    });
  }
});
