/**
 * Tests for adapters/storage/s3-storage.adapter.ts
 *
 * Mocks the AWS SDK S3Client.send() to verify correct commands
 * are sent for each StoragePort method.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// Mock the AWS SDK modules
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      constructor(public config: unknown) {}
      send = mockSend;
    },
    PutObjectCommand: class { constructor(public input: unknown) {} },
    GetObjectCommand: class { constructor(public input: unknown) {} },
    HeadObjectCommand: class { constructor(public input: unknown) {} },
    DeleteObjectCommand: class { constructor(public input: unknown) {} },
    ListObjectsV2Command: class { constructor(public input: unknown) {} },
  };
});

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(public params: unknown) {}
    async done() { return {}; }
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/file'),
}));

import { S3StorageAdapter } from '../adapters/storage/s3-storage.adapter.js';

describe('S3StorageAdapter', () => {
  let adapter: S3StorageAdapter;

  beforeEach(() => {
    mockSend.mockReset();
    adapter = new S3StorageAdapter({ bucketName: 'test-bucket' });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('throws without bucket name', () => {
    expect(() => new S3StorageAdapter({ bucketName: '' })).toThrow('BUCKET_NAME is required');
  });

  it('exposes bucket name', () => {
    expect(adapter.getBucketName()).toBe('test-bucket');
  });

  // -----------------------------------------------------------------------
  // writeFile
  // -----------------------------------------------------------------------

  it('sends PutObjectCommand with correct params', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await adapter.writeFile('path/file.json', '{"key":"val"}', 'application/json');

    expect(result).toBe('path/file.json');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'path/file.json',
      Body: Buffer.from('{"key":"val"}', 'utf-8'),
      ContentType: 'application/json',
    });
  });

  it('auto-detects content type from extension', async () => {
    mockSend.mockResolvedValueOnce({});
    await adapter.writeFile('report.html', '<html></html>');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.ContentType).toBe('text/html; charset=utf-8');
  });

  it('accepts Buffer content', async () => {
    mockSend.mockResolvedValueOnce({});
    const buf = Buffer.from('binary');
    await adapter.writeFile('file.bin', buf);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Body).toBe(buf);
  });

  // -----------------------------------------------------------------------
  // readFile
  // -----------------------------------------------------------------------

  it('reads file and returns Buffer', async () => {
    const stream = Readable.from([Buffer.from('hello')]);
    mockSend.mockResolvedValueOnce({ Body: stream });

    const result = await adapter.readFile('path/file.txt');
    expect(result.toString()).toBe('hello');
  });

  // -----------------------------------------------------------------------
  // readFileAsString
  // -----------------------------------------------------------------------

  it('reads file as string with encoding', async () => {
    const stream = Readable.from([Buffer.from('text content')]);
    mockSend.mockResolvedValueOnce({ Body: stream });

    const result = await adapter.readFileAsString('file.txt', 'utf-8');
    expect(result).toBe('text content');
  });

  // -----------------------------------------------------------------------
  // appendFile
  // -----------------------------------------------------------------------

  it('reads existing content and writes combined', async () => {
    // First call: readFile (GetObject)
    const existingStream = Readable.from([Buffer.from('existing ')]);
    mockSend.mockResolvedValueOnce({ Body: existingStream });
    // Second call: writeFile (PutObject)
    mockSend.mockResolvedValueOnce({});

    await adapter.appendFile('file.txt', 'new content');

    // Verify the PutObject call has combined content
    const putCmd = mockSend.mock.calls[1][0];
    expect(putCmd.input.Body.toString()).toBe('existing new content');
  });

  it('creates file if it does not exist (NoSuchKey)', async () => {
    // readFile throws NoSuchKey
    mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' });
    // writeFile succeeds
    mockSend.mockResolvedValueOnce({});

    await adapter.appendFile('new.txt', 'brand new');

    const putCmd = mockSend.mock.calls[1][0];
    expect(putCmd.input.Body.toString()).toBe('brand new');
  });

  // -----------------------------------------------------------------------
  // ensureDir
  // -----------------------------------------------------------------------

  it('ensureDir is a no-op for S3', async () => {
    await expect(adapter.ensureDir('any/path')).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // exists / fileExists
  // -----------------------------------------------------------------------

  it('returns true when file exists (HeadObject succeeds)', async () => {
    mockSend.mockResolvedValueOnce({ LastModified: new Date('2024-01-01') });
    expect(await adapter.exists('file.txt')).toBe(true);
  });

  it('returns false when file does not exist (NotFound)', async () => {
    mockSend.mockRejectedValueOnce({ name: 'NotFound' });
    expect(await adapter.exists('nope.txt')).toBe(false);
  });

  it('fileExists returns lastModified date', async () => {
    const date = new Date('2024-06-15');
    mockSend.mockResolvedValueOnce({ LastModified: date });
    const result = await adapter.fileExists('file.txt');
    expect(result).toEqual({ exists: true, lastModified: date });
  });

  it('fileExists returns exists:false for NoSuchKey', async () => {
    mockSend.mockRejectedValueOnce({ name: 'NoSuchKey' });
    const result = await adapter.fileExists('ghost.txt');
    expect(result).toEqual({ exists: false });
  });

  it('fileExists rethrows unknown errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('NetworkError'));
    await expect(adapter.fileExists('file.txt')).rejects.toThrow('NetworkError');
  });

  // -----------------------------------------------------------------------
  // getSignedUrl
  // -----------------------------------------------------------------------

  it('returns a presigned URL', async () => {
    const url = await adapter.getSignedUrl('file.pdf');
    expect(url).toBe('https://signed-url.example.com/file');
  });

  // -----------------------------------------------------------------------
  // deleteFile
  // -----------------------------------------------------------------------

  it('deletes existing file and returns true', async () => {
    // fileExists (HeadObject) succeeds
    mockSend.mockResolvedValueOnce({ LastModified: new Date() });
    // DeleteObject succeeds
    mockSend.mockResolvedValueOnce({});

    const result = await adapter.deleteFile('file.txt');
    expect(result).toBe(true);
  });

  it('returns false when file does not exist', async () => {
    mockSend.mockRejectedValueOnce({ name: 'NotFound' });
    const result = await adapter.deleteFile('nope.txt');
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // listFiles
  // -----------------------------------------------------------------------

  it('lists files with prefix', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: 'dir/a.txt' }, { Key: 'dir/b.txt' }],
      NextContinuationToken: undefined,
    });

    const files = await adapter.listFiles('dir/');
    expect(files).toEqual(['dir/a.txt', 'dir/b.txt']);
  });

  it('paginates through multiple pages', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: 'file1.txt' }],
      NextContinuationToken: 'token-1',
    });
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: 'file2.txt' }],
      NextContinuationToken: undefined,
    });

    const files = await adapter.listFiles('');
    expect(files).toEqual(['file1.txt', 'file2.txt']);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no contents', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: undefined,
      NextContinuationToken: undefined,
    });

    const files = await adapter.listFiles('empty/');
    expect(files).toEqual([]);
  });

  it('skips objects without Key', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: 'valid.txt' }, { Key: undefined }, { Key: 'also-valid.txt' }],
      NextContinuationToken: undefined,
    });

    const files = await adapter.listFiles('');
    expect(files).toEqual(['valid.txt', 'also-valid.txt']);
  });

  // -----------------------------------------------------------------------
  // Content type detection
  // -----------------------------------------------------------------------

  it('detects common content types', async () => {
    const cases = [
      ['file.pdf', 'application/pdf'],
      ['file.png', 'image/png'],
      ['file.json', 'application/json'],
      ['file.csv', 'text/csv'],
      ['file.unknown', 'application/octet-stream'],
    ];

    for (const [filename, expectedType] of cases) {
      mockSend.mockResolvedValueOnce({});
      await adapter.writeFile(filename, 'x');
      const cmd = mockSend.mock.calls[mockSend.mock.calls.length - 1][0];
      expect(cmd.input.ContentType).toBe(expectedType);
    }
  });
});
