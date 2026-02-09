/**
 * Storage Factory
 *
 * Creates the appropriate storage adapter based on configuration.
 * Supports local and S3 storage backends.
 */

import type { StoragePort } from '../../application/ports/storage.port.js';
import { LocalStorageAdapter } from './local-storage.adapter.js';
import { S3StorageAdapter } from './s3-storage.adapter.js';

export type StorageProvider = 'local' | 's3';

export interface StorageFactoryConfig {
  provider: StorageProvider;
  bucketName?: string;
  region?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  localBaseDir?: string;
  signedUrlExpirationHours?: number;
}

/**
 * Create a storage adapter from explicit configuration
 */
export function createStorageAdapter(config: StorageFactoryConfig): StoragePort {
  switch (config.provider) {
    case 'local':
      return new LocalStorageAdapter({
        baseDir: config.localBaseDir,
      });

    case 's3':
      if (!config.bucketName) {
        throw new Error('BUCKET_NAME is required for S3 storage');
      }
      return new S3StorageAdapter({
        bucketName: config.bucketName,
        region: config.region,
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
        signedUrlExpirationHours: config.signedUrlExpirationHours,
      });

    default:
      throw new Error(`Unknown storage provider: ${config.provider}`);
  }
}

/**
 * Create a storage adapter from environment variables
 *
 * Environment variables:
 * - STORAGE_PROVIDER: 'local' | 's3' (default: 'local')
 * - BUCKET_NAME: Required for S3
 * - AWS_REGION: AWS region (default: 'us-east-2')
 * - AWS_ACCESS_KEY_ID: Optional, uses IAM/IRSA if not set
 * - AWS_SECRET_ACCESS_KEY: Optional
 * - STORAGE_BASE_DIR: Local storage base directory (default: './storage')
 */
export function createStorageAdapterFromEnv(): StoragePort {
  const provider = (process.env.STORAGE_PROVIDER ?? 'local') as StorageProvider;

  // Validate provider
  if (!['local', 's3'].includes(provider)) {
    throw new Error(
      `Invalid STORAGE_PROVIDER: ${provider}. Must be 'local' or 's3'`
    );
  }

  return createStorageAdapter({
    provider,
    bucketName: process.env.BUCKET_NAME,
    region: process.env.AWS_REGION,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    localBaseDir: process.env.STORAGE_BASE_DIR,
  });
}

/**
 * Get the current storage provider from environment
 */
export function getStorageProvider(): StorageProvider {
  return (process.env.STORAGE_PROVIDER ?? 'local') as StorageProvider;
}

/**
 * Check if cloud storage is configured
 */
export function isCloudStorageEnabled(): boolean {
  const provider = getStorageProvider();
  return provider === 's3';
}
