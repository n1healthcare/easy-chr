/**
 * Tests for adapters/storage/storage.factory.ts
 *
 * Verifies createStorageAdapter, createStorageAdapterFromEnv,
 * getStorageProvider, and isCloudStorageEnabled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createStorageAdapter,
  createStorageAdapterFromEnv,
  getStorageProvider,
  isCloudStorageEnabled,
} from '../adapters/storage/storage.factory.js';
import { LocalStorageAdapter } from '../adapters/storage/local-storage.adapter.js';
import { S3StorageAdapter } from '../adapters/storage/s3-storage.adapter.js';

describe('createStorageAdapter', () => {
  it('creates LocalStorageAdapter for "local" provider', () => {
    const adapter = createStorageAdapter({ provider: 'local' });
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it('creates LocalStorageAdapter with custom baseDir', () => {
    const adapter = createStorageAdapter({
      provider: 'local',
      localBaseDir: '/tmp/test-storage',
    });
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
    expect((adapter as LocalStorageAdapter).getBaseDir()).toBe('/tmp/test-storage');
  });

  it('creates S3StorageAdapter for "s3" provider', () => {
    const adapter = createStorageAdapter({
      provider: 's3',
      bucketName: 'test-bucket',
    });
    expect(adapter).toBeInstanceOf(S3StorageAdapter);
  });

  it('throws when S3 provider has no bucket name', () => {
    expect(() =>
      createStorageAdapter({ provider: 's3' })
    ).toThrow('BUCKET_NAME is required');
  });

  it('throws for unknown provider', () => {
    expect(() =>
      createStorageAdapter({ provider: 'gcs' as any })
    ).toThrow('Unknown storage provider: gcs');
  });
});

describe('createStorageAdapterFromEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STORAGE_PROVIDER;
    delete process.env.BUCKET_NAME;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.STORAGE_BASE_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to local provider when STORAGE_PROVIDER not set', () => {
    const adapter = createStorageAdapterFromEnv();
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it('creates S3 adapter when STORAGE_PROVIDER=s3', () => {
    process.env.STORAGE_PROVIDER = 's3';
    process.env.BUCKET_NAME = 'my-bucket';
    const adapter = createStorageAdapterFromEnv();
    expect(adapter).toBeInstanceOf(S3StorageAdapter);
  });

  it('throws for invalid STORAGE_PROVIDER', () => {
    process.env.STORAGE_PROVIDER = 'azure';
    expect(() => createStorageAdapterFromEnv()).toThrow('Invalid STORAGE_PROVIDER: azure');
  });
});

describe('getStorageProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns "local" by default', () => {
    delete process.env.STORAGE_PROVIDER;
    expect(getStorageProvider()).toBe('local');
  });

  it('returns env value when set', () => {
    process.env.STORAGE_PROVIDER = 's3';
    expect(getStorageProvider()).toBe('s3');
  });
});

describe('isCloudStorageEnabled', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns false for local', () => {
    delete process.env.STORAGE_PROVIDER;
    expect(isCloudStorageEnabled()).toBe(false);
  });

  it('returns true for s3', () => {
    process.env.STORAGE_PROVIDER = 's3';
    expect(isCloudStorageEnabled()).toBe(true);
  });
});
