/**
 * Storage Port Interface
 *
 * Defines the contract for storage operations across different backends.
 * Supports local filesystem, AWS S3, and Google Cloud Storage.
 *
 * Follows N1 standard patterns from n1-document-manager.
 */

import type { Writable } from 'stream';

/**
 * Result of a file existence check
 */
export interface FileExistsResult {
  exists: boolean;
  lastModified?: Date;
}

/**
 * Options for signed URL generation
 */
export interface SignedUrlOptions {
  expirationHours?: number;
  contentType?: string;
}

/**
 * Storage port interface for hexagonal architecture
 */
export interface StoragePort {
  /**
   * Write content to a file path
   * @param path - Destination path (relative to bucket/base dir)
   * @param content - String or Buffer content to write
   * @param contentType - Optional MIME type (auto-detected if not provided)
   * @returns The path where the file was written
   */
  writeFile(path: string, content: string | Buffer, contentType?: string): Promise<string>;

  /**
   * Read file contents as a Buffer
   * @param path - Path to read from
   * @returns Buffer containing file contents
   */
  readFile(path: string): Promise<Buffer>;

  /**
   * Read file contents as a string
   * @param path - Path to read from
   * @param encoding - Character encoding (defaults to 'utf-8')
   * @returns String contents of the file
   */
  readFileAsString(path: string, encoding?: BufferEncoding): Promise<string>;

  /**
   * Append content to an existing file
   * Note: For S3/GCS, this reads the existing content and rewrites the whole file
   * @param path - Path to append to
   * @param content - Content to append
   */
  appendFile(path: string, content: string): Promise<void>;

  /**
   * Ensure a directory exists (no-op for object storage like S3/GCS)
   * @param path - Directory path to create
   */
  ensureDir(path: string): Promise<void>;

  /**
   * Check if a file exists
   * @param path - Path to check
   * @returns True if file exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Check if a file exists with metadata
   * @param path - Path to check
   * @returns Object with exists boolean and optional lastModified date
   */
  fileExists(path: string): Promise<FileExistsResult>;

  /**
   * Create a writable stream for the given path
   * Useful for large file uploads where you want to pipe data
   * @param path - Destination path
   * @param contentType - Optional MIME type
   * @returns A writable stream
   */
  createWriteStream(path: string, contentType?: string): Promise<Writable>;

  /**
   * Generate a signed URL for downloading a file
   * @param path - Path to the file
   * @param options - URL generation options
   * @returns A time-limited URL for accessing the file
   */
  getSignedUrl(path: string, options?: SignedUrlOptions): Promise<string>;

  /**
   * Delete a file
   * @param path - Path to delete
   * @returns True if file was deleted, false if it didn't exist
   */
  deleteFile(path: string): Promise<boolean>;

  /**
   * List files with a given prefix
   * @param prefix - Path prefix to filter by
   * @returns Array of file paths matching the prefix
   */
  listFiles(prefix: string): Promise<string[]>;
}
