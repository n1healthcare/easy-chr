/**
 * Google Cloud Storage Adapter
 *
 * Handles uploading generated HTML reports to GCS buckets.
 * Used in job mode to persist results for user download.
 */

import { Storage } from '@google-cloud/storage';

export interface StoragePort {
  uploadHtml(content: string, destinationPath: string): Promise<string>;
}

export class GcsStorageAdapter implements StoragePort {
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string, projectId: string, credentialsJson: string) {
    if (!bucketName) {
      throw new Error('BUCKET_NAME is required');
    }
    if (!projectId) {
      throw new Error('PROJECT_ID is required');
    }
    if (!credentialsJson) {
      throw new Error('GCS_SERVICE_ACCOUNT_JSON is required');
    }

    this.bucketName = bucketName;

    // Parse credentials from JSON string
    let credentials;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (error) {
      throw new Error('Invalid GCS_SERVICE_ACCOUNT_JSON: Must be valid JSON');
    }

    this.storage = new Storage({
      projectId,
      credentials,
    });
  }

  /**
   * Upload HTML content to GCS
   * @param content - HTML content to upload
   * @param destinationPath - Path in bucket (e.g., "reports/abc123/index.html")
   * @returns Public URL of uploaded file
   */
  async uploadHtml(content: string, destinationPath: string): Promise<string> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(destinationPath);

    console.log(`  📤 Uploading to gs://${this.bucketName}/${destinationPath}`);

    await file.save(content, {
      metadata: {
        contentType: 'text/html',
        cacheControl: 'public, max-age=3600',
      },
    });

    // Make file publicly accessible
    await file.makePublic();

    // Return public URL
    const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${destinationPath}`;

    return publicUrl;
  }
}
