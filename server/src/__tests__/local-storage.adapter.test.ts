/**
 * Tests for adapters/storage/local-storage.adapter.ts
 *
 * Uses a real temporary directory to test filesystem operations.
 * Cleans up after each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalStorageAdapter } from '../adapters/storage/local-storage.adapter.js';

describe('LocalStorageAdapter', () => {
  let tmpDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-storage-test-'));
    adapter = new LocalStorageAdapter({ baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('uses provided baseDir', () => {
    expect(adapter.getBaseDir()).toBe(tmpDir);
  });

  it('defaults to process.cwd()/storage when no config', () => {
    const defaultAdapter = new LocalStorageAdapter();
    expect(defaultAdapter.getBaseDir()).toBe(path.join(process.cwd(), 'storage'));
  });

  // -----------------------------------------------------------------------
  // writeFile
  // -----------------------------------------------------------------------

  it('writes string content and returns the path', async () => {
    const result = await adapter.writeFile('test.txt', 'hello world');
    expect(result).toBe('test.txt');

    const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('writes Buffer content', async () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    await adapter.writeFile('binary.bin', buf);

    const content = fs.readFileSync(path.join(tmpDir, 'binary.bin'));
    expect(content).toEqual(buf);
  });

  it('creates intermediate directories', async () => {
    await adapter.writeFile('deep/nested/dir/file.txt', 'content');
    const content = fs.readFileSync(path.join(tmpDir, 'deep/nested/dir/file.txt'), 'utf-8');
    expect(content).toBe('content');
  });

  // -----------------------------------------------------------------------
  // readFile
  // -----------------------------------------------------------------------

  it('reads file as Buffer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'read.txt'), 'test data');
    const result = await adapter.readFile('read.txt');
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe('test data');
  });

  it('throws on non-existent file', async () => {
    await expect(adapter.readFile('nope.txt')).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // readFileAsString
  // -----------------------------------------------------------------------

  it('reads file as string with default utf-8', async () => {
    fs.writeFileSync(path.join(tmpDir, 'str.txt'), 'utf8 content');
    const result = await adapter.readFileAsString('str.txt');
    expect(result).toBe('utf8 content');
  });

  it('reads file with specified encoding', async () => {
    fs.writeFileSync(path.join(tmpDir, 'latin.txt'), Buffer.from('hello', 'ascii'));
    const result = await adapter.readFileAsString('latin.txt', 'ascii');
    expect(result).toBe('hello');
  });

  // -----------------------------------------------------------------------
  // appendFile
  // -----------------------------------------------------------------------

  it('appends to existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'append.txt'), 'line1\n');
    await adapter.appendFile('append.txt', 'line2\n');
    const content = fs.readFileSync(path.join(tmpDir, 'append.txt'), 'utf-8');
    expect(content).toBe('line1\nline2\n');
  });

  it('creates file if it does not exist', async () => {
    await adapter.appendFile('new-append.txt', 'first');
    const content = fs.readFileSync(path.join(tmpDir, 'new-append.txt'), 'utf-8');
    expect(content).toBe('first');
  });

  // -----------------------------------------------------------------------
  // ensureDir
  // -----------------------------------------------------------------------

  it('creates directory if it does not exist', async () => {
    await adapter.ensureDir('a/b/c');
    const stat = fs.statSync(path.join(tmpDir, 'a/b/c'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('is a no-op if directory already exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'existing'), { recursive: true });
    await expect(adapter.ensureDir('existing')).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // exists
  // -----------------------------------------------------------------------

  it('returns true for existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'exists.txt'), 'x');
    expect(await adapter.exists('exists.txt')).toBe(true);
  });

  it('returns false for non-existent file', async () => {
    expect(await adapter.exists('no.txt')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // fileExists
  // -----------------------------------------------------------------------

  it('returns exists:true with lastModified for existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'meta.txt'), 'x');
    const result = await adapter.fileExists('meta.txt');
    expect(result.exists).toBe(true);
    expect(result.lastModified).toBeInstanceOf(Date);
  });

  it('returns exists:false for non-existent file', async () => {
    const result = await adapter.fileExists('ghost.txt');
    expect(result.exists).toBe(false);
    expect(result.lastModified).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // createWriteStream
  // -----------------------------------------------------------------------

  it('returns a writable stream', async () => {
    const stream = await adapter.createWriteStream('stream.txt');
    await new Promise<void>((resolve, reject) => {
      stream.write('streamed data', (err) => {
        if (err) reject(err);
        stream.end(resolve);
      });
    });
    const content = fs.readFileSync(path.join(tmpDir, 'stream.txt'), 'utf-8');
    expect(content).toBe('streamed data');
  });

  // -----------------------------------------------------------------------
  // getSignedUrl
  // -----------------------------------------------------------------------

  it('returns a file:// URL for local storage', async () => {
    const url = await adapter.getSignedUrl('some/file.pdf');
    expect(url).toBe(`file://${path.join(tmpDir, 'some/file.pdf')}`);
  });

  // -----------------------------------------------------------------------
  // deleteFile
  // -----------------------------------------------------------------------

  it('deletes existing file and returns true', async () => {
    fs.writeFileSync(path.join(tmpDir, 'del.txt'), 'delete me');
    const result = await adapter.deleteFile('del.txt');
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'del.txt'))).toBe(false);
  });

  it('returns false for non-existent file', async () => {
    const result = await adapter.deleteFile('nope.txt');
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // listFiles
  // -----------------------------------------------------------------------

  it('lists files recursively under prefix', async () => {
    fs.mkdirSync(path.join(tmpDir, 'dir/sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dir/a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'dir/sub/b.txt'), 'b');

    const files = await adapter.listFiles('dir');
    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(['dir/a.txt', 'dir/sub/b.txt'].sort());
  });

  it('returns empty array for non-existent prefix', async () => {
    const files = await adapter.listFiles('nonexistent');
    expect(files).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // resolvePath (absolute path handling)
  // -----------------------------------------------------------------------

  it('handles absolute paths as-is', async () => {
    const absPath = path.join(tmpDir, 'absolute.txt');
    fs.writeFileSync(absPath, 'absolute content');
    const content = await adapter.readFileAsString(absPath);
    expect(content).toBe('absolute content');
  });
});
