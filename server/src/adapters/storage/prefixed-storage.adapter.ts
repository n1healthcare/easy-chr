/**
 * Prefixed Storage Adapter
 *
 * Wraps any StoragePort and prepends a path prefix to all operations.
 * Used to scope intermediate files under a user-specific directory
 * (e.g., users/{userId}/easychr_files/) without changing the use case code.
 */

import type { Writable } from 'stream';
import type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';

export class PrefixedStorageAdapter implements StoragePort {
  constructor(
    private readonly inner: StoragePort,
    private readonly prefix: string
  ) {}

  private prefixed(path: string): string {
    if (!this.prefix) return path;
    return `${this.prefix}/${path}`.replace(/\/+/g, '/');
  }

  async writeFile(path: string, content: string | Buffer, contentType?: string): Promise<string> {
    return this.inner.writeFile(this.prefixed(path), content, contentType);
  }

  async readFile(path: string): Promise<Buffer> {
    return this.inner.readFile(this.prefixed(path));
  }

  async readFileAsString(path: string, encoding?: BufferEncoding): Promise<string> {
    return this.inner.readFileAsString(this.prefixed(path), encoding);
  }

  async appendFile(path: string, content: string): Promise<void> {
    return this.inner.appendFile(this.prefixed(path), content);
  }

  async ensureDir(path: string): Promise<void> {
    return this.inner.ensureDir(this.prefixed(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.inner.exists(this.prefixed(path));
  }

  async fileExists(path: string): Promise<FileExistsResult> {
    return this.inner.fileExists(this.prefixed(path));
  }

  async createWriteStream(path: string, contentType?: string): Promise<Writable> {
    return this.inner.createWriteStream(this.prefixed(path), contentType);
  }

  async getSignedUrl(path: string, options?: SignedUrlOptions): Promise<string> {
    return this.inner.getSignedUrl(this.prefixed(path), options);
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.inner.deleteFile(this.prefixed(path));
  }

  async listFiles(prefix: string): Promise<string[]> {
    return this.inner.listFiles(this.prefixed(prefix));
  }
}
