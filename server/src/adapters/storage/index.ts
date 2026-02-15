/**
 * Storage Adapters - Barrel Export
 *
 * Re-exports all storage-related types, adapters, and utilities.
 */

// Port interface
export type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';

// Adapters
export { LocalStorageAdapter } from './local-storage.adapter.js';
export type { LocalStorageConfig } from './local-storage.adapter.js';

export { S3StorageAdapter } from './s3-storage.adapter.js';
export type { S3StorageConfig } from './s3-storage.adapter.js';

export { PrefixedStorageAdapter } from './prefixed-storage.adapter.js';

export { RetryableStorageAdapter } from './retryable-storage.adapter.js';

// Factory
export {
  createStorageAdapter,
  createStorageAdapterFromEnv,
  getStorageProvider,
  isCloudStorageEnabled,
} from './storage.factory.js';
export type {
  StorageProvider,
  StorageFactoryConfig,
} from './storage.factory.js';
