/**
 * Retryable Storage Adapter
 *
 * Wraps any StoragePort and adds automatic retry with exponential backoff
 * to all operations. This ensures transient S3/storage errors don't cause
 * data loss for successfully generated reports.
 *
 * createWriteStream is exempt — streaming can't be retried atomically.
 */

import type { Writable } from 'stream';
import type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';
import { withRetry, type RetryConfig } from '../../common/retry.js';

export class RetryableStorageAdapter implements StoragePort {
  constructor(
    private readonly inner: StoragePort,
    private readonly retryConfig: RetryConfig
  ) {}

  private cfg(operationName: string): RetryConfig {
    return { ...this.retryConfig, operationName };
  }

  async writeFile(path: string, content: string | Buffer, contentType?: string): Promise<string> {
    return withRetry(() => this.inner.writeFile(path, content, contentType), this.cfg('Storage.writeFile'));
  }

  async readFile(path: string): Promise<Buffer> {
    return withRetry(() => this.inner.readFile(path), this.cfg('Storage.readFile'));
  }

  async readFileAsString(path: string, encoding?: BufferEncoding): Promise<string> {
    return withRetry(() => this.inner.readFileAsString(path, encoding), this.cfg('Storage.readFileAsString'));
  }

  async appendFile(path: string, content: string): Promise<void> {
    return withRetry(() => this.inner.appendFile(path, content), this.cfg('Storage.appendFile'));
  }

  async ensureDir(path: string): Promise<void> {
    return withRetry(() => this.inner.ensureDir(path), this.cfg('Storage.ensureDir'));
  }

  async exists(path: string): Promise<boolean> {
    return withRetry(() => this.inner.exists(path), this.cfg('Storage.exists'));
  }

  async fileExists(path: string): Promise<FileExistsResult> {
    return withRetry(() => this.inner.fileExists(path), this.cfg('Storage.fileExists'));
  }

  /** Streaming cannot be retried atomically — delegates without retry. */
  async createWriteStream(path: string, contentType?: string): Promise<Writable> {
    return this.inner.createWriteStream(path, contentType);
  }

  async getSignedUrl(path: string, options?: SignedUrlOptions): Promise<string> {
    return withRetry(() => this.inner.getSignedUrl(path, options), this.cfg('Storage.getSignedUrl'));
  }

  async deleteFile(path: string): Promise<boolean> {
    return withRetry(() => this.inner.deleteFile(path), this.cfg('Storage.deleteFile'));
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(() => this.inner.listFiles(prefix), this.cfg('Storage.listFiles'));
  }
}
