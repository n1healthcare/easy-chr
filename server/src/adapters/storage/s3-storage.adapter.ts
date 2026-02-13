/**
 * S3 Storage Adapter
 *
 * Implements StoragePort using AWS S3.
 * Follows N1 standard patterns from n1-document-manager.
 *
 * Supports:
 * - IAM/IRSA credentials (recommended for K8s)
 * - Explicit credentials via config
 * - Environment variable credentials (AWS SDK default chain)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable, PassThrough } from 'stream';
import type { Writable } from 'stream';
import type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';
import { getLogger } from '../../logger.js';

export interface S3StorageConfig {
  bucketName: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  signedUrlExpirationHours?: number;
}

export class S3StorageAdapter implements StoragePort {
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly defaultExpirationHours: number;
  private readonly logger = getLogger().child({ component: 'S3StorageAdapter' });

  constructor(config: S3StorageConfig) {
    if (!config.bucketName) {
      throw new Error('BUCKET_NAME is required for S3 storage');
    }

    this.bucketName = config.bucketName;
    this.defaultExpirationHours = config.signedUrlExpirationHours ?? 168; // 7 days

    const clientConfig: {
      region: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    } = {
      region: config.region ?? 'us-east-2',
    };

    // Only set credentials if explicitly provided
    // Otherwise, SDK uses IAM/IRSA credential chain
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  async writeFile(
    path: string,
    content: string | Buffer,
    contentType?: string
  ): Promise<string> {
    const body =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Body: body,
        ContentType: contentType ?? this.detectContentType(path),
      })
    );

    return path;
  }

  async readFile(path: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async readFileAsString(
    path: string,
    encoding: BufferEncoding = 'utf-8'
  ): Promise<string> {
    const buffer = await this.readFile(path);
    return buffer.toString(encoding);
  }

  async appendFile(path: string, content: string): Promise<void> {
    // S3 doesn't support append - read existing content and rewrite
    let existing = '';
    try {
      existing = await this.readFileAsString(path);
    } catch (error: unknown) {
      const s3Error = error as { name?: string };
      if (s3Error.name !== 'NoSuchKey') {
        throw error;
      }
      // File doesn't exist, that's fine - we'll create it
    }

    await this.writeFile(path, existing + content);
  }

  async ensureDir(_path: string): Promise<void> {
    // S3 has no directories - this is a no-op
    // Objects are stored with their full key path
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.fileExists(path);
    return result.exists;
  }

  async fileExists(path: string): Promise<FileExistsResult> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: path,
        })
      );
      return {
        exists: true,
        lastModified: response.LastModified,
      };
    } catch (error: unknown) {
      const s3Error = error as { name?: string };
      if (s3Error.name === 'NotFound' || s3Error.name === 'NoSuchKey') {
        return { exists: false };
      }
      throw error;
    }
  }

  async createWriteStream(
    path: string,
    contentType?: string
  ): Promise<Writable> {
    const passThrough = new PassThrough();

    // Start multipart upload in background
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: path,
        Body: passThrough,
        ContentType: contentType ?? this.detectContentType(path),
      },
    });

    // Handle completion/errors in background
    upload.done().catch((error) => {
      this.logger.error({ err: error, path }, 'S3 upload error');
      passThrough.destroy(error as Error);
    });

    return passThrough;
  }

  async getSignedUrl(
    path: string,
    options?: SignedUrlOptions
  ): Promise<string> {
    const expirationHours =
      options?.expirationHours ?? this.defaultExpirationHours;

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: path,
    });

    return getSignedUrl(this.client, command, {
      expiresIn: expirationHours * 3600,
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    // Check if file exists first
    const existsResult = await this.fileExists(path);
    if (!existsResult.exists) {
      return false;
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      })
    );

    return true;
  }

  async listFiles(prefix: string): Promise<string[]> {
    const results: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            results.push(object.Key);
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return results;
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
      glb: 'model/gltf-binary',
      gltf: 'model/gltf+json',
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
