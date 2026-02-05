/**
 * Google Cloud Storage Adapter
 *
 * Implements StoragePort for Google Cloud Storage.
 * Handles uploading, downloading, and managing files in GCS buckets.
 */

import { Storage } from '@google-cloud/storage';
import { Readable, PassThrough } from 'stream';
import type { Writable } from 'stream';
import type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';

export interface GcsStorageConfig {
  bucketName: string;
  projectId: string;
  credentialsJson: string;
  signedUrlExpirationHours?: number;
}

export class GcsStorageAdapter implements StoragePort {
  private storage: Storage;
  private bucketName: string;
  private defaultExpirationHours: number;

  constructor(bucketName: string, projectId: string, credentialsJson: string);
  constructor(config: GcsStorageConfig);
  constructor(
    bucketNameOrConfig: string | GcsStorageConfig,
    projectId?: string,
    credentialsJson?: string
  ) {
    // Support both old constructor signature and new config-based one
    let config: GcsStorageConfig;

    if (typeof bucketNameOrConfig === 'string') {
      // Legacy constructor: (bucketName, projectId, credentialsJson)
      if (!bucketNameOrConfig) {
        throw new Error('BUCKET_NAME is required');
      }
      if (!projectId) {
        throw new Error('PROJECT_ID is required');
      }
      if (!credentialsJson) {
        throw new Error('GCS_SERVICE_ACCOUNT_JSON is required');
      }
      config = {
        bucketName: bucketNameOrConfig,
        projectId,
        credentialsJson,
      };
    } else {
      // New constructor: (config)
      config = bucketNameOrConfig;
    }

    if (!config.bucketName) {
      throw new Error('BUCKET_NAME is required');
    }
    if (!config.projectId) {
      throw new Error('PROJECT_ID is required');
    }
    if (!config.credentialsJson) {
      throw new Error('GCS_SERVICE_ACCOUNT_JSON is required');
    }

    this.bucketName = config.bucketName;
    this.defaultExpirationHours = config.signedUrlExpirationHours ?? 168; // 7 days

    // Parse credentials from JSON string
    let credentials;
    try {
      credentials = JSON.parse(config.credentialsJson);
    } catch {
      throw new Error('Invalid GCS_SERVICE_ACCOUNT_JSON: Must be valid JSON');
    }

    this.storage = new Storage({
      projectId: config.projectId,
      credentials,
    });
  }

  async writeFile(
    path: string,
    content: string | Buffer,
    contentType?: string
  ): Promise<string> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    const body =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    await file.save(body, {
      metadata: {
        contentType: contentType ?? this.detectContentType(path),
        cacheControl: 'public, max-age=3600',
      },
    });

    console.log(`[GCS] Uploaded to gs://${this.bucketName}/${path}`);
    return path;
  }

  async readFile(path: string): Promise<Buffer> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    const [contents] = await file.download();
    return contents;
  }

  async readFileAsString(
    path: string,
    encoding: BufferEncoding = 'utf-8'
  ): Promise<string> {
    const buffer = await this.readFile(path);
    return buffer.toString(encoding);
  }

  async appendFile(path: string, content: string): Promise<void> {
    // GCS doesn't support append - read existing content and rewrite
    let existing = '';
    try {
      existing = await this.readFileAsString(path);
    } catch (error: unknown) {
      const gcsError = error as { code?: number };
      if (gcsError.code !== 404) {
        throw error;
      }
      // File doesn't exist, that's fine - we'll create it
    }

    await this.writeFile(path, existing + content);
  }

  async ensureDir(_path: string): Promise<void> {
    // GCS has no directories - this is a no-op
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.fileExists(path);
    return result.exists;
  }

  async fileExists(path: string): Promise<FileExistsResult> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    try {
      const [exists] = await file.exists();
      if (!exists) {
        return { exists: false };
      }

      const [metadata] = await file.getMetadata();
      return {
        exists: true,
        lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
      };
    } catch {
      return { exists: false };
    }
  }

  async createWriteStream(
    path: string,
    contentType?: string
  ): Promise<Writable> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    const stream = file.createWriteStream({
      metadata: {
        contentType: contentType ?? this.detectContentType(path),
        cacheControl: 'public, max-age=3600',
      },
    });

    return stream;
  }

  async getSignedUrl(
    path: string,
    options?: SignedUrlOptions
  ): Promise<string> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    const expirationHours =
      options?.expirationHours ?? this.defaultExpirationHours;

    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expirationHours * 60 * 60 * 1000,
    });

    console.log(`[GCS] Generated signed URL for ${path} (expires in ${expirationHours}h)`);
    return signedUrl;
  }

  async deleteFile(path: string): Promise<boolean> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(path);

    try {
      const [exists] = await file.exists();
      if (!exists) {
        return false;
      }

      await file.delete();
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    const bucket = this.storage.bucket(this.bucketName);
    const [files] = await bucket.getFiles({ prefix });

    return files.map((file) => file.name);
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use writeFile() and getSignedUrl() instead
   */
  async uploadHtml(content: string, destinationPath: string): Promise<string> {
    await this.writeFile(destinationPath, content, 'text/html');
    return this.getSignedUrl(destinationPath);
  }

  /**
   * Detect content type from file extension
   */
  private detectContentType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      htm: 'text/html; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      json: 'application/json',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      txt: 'text/plain; charset=utf-8',
      css: 'text/css',
      js: 'application/javascript',
      xml: 'application/xml',
      csv: 'text/csv',
    };
    return types[ext ?? ''] ?? 'application/octet-stream';
  }

  /**
   * Get bucket name (useful for debugging)
   */
  getBucketName(): string {
    return this.bucketName;
  }
}
