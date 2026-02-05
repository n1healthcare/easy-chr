/**
 * Local Storage Adapter
 *
 * Implements StoragePort using the local filesystem.
 * Used for local development and testing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import type {
  StoragePort,
  FileExistsResult,
  SignedUrlOptions,
} from '../../application/ports/storage.port.js';

export interface LocalStorageConfig {
  baseDir?: string;
}

export class LocalStorageAdapter implements StoragePort {
  private readonly baseDir: string;

  constructor(config: LocalStorageConfig = {}) {
    this.baseDir = config.baseDir ?? path.join(process.cwd(), 'storage');
  }

  async writeFile(
    filePath: string,
    content: string | Buffer,
    _contentType?: string
  ): Promise<string> {
    const fullPath = this.resolvePath(filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, content);
    return filePath;
  }

  async readFile(filePath: string): Promise<Buffer> {
    const fullPath = this.resolvePath(filePath);
    return fs.promises.readFile(fullPath);
  }

  async readFileAsString(
    filePath: string,
    encoding: BufferEncoding = 'utf-8'
  ): Promise<string> {
    const fullPath = this.resolvePath(filePath);
    return fs.promises.readFile(fullPath, encoding);
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.appendFile(fullPath, content);
  }

  async ensureDir(dirPath: string): Promise<void> {
    const fullPath = this.resolvePath(dirPath);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = this.resolvePath(filePath);
    return fs.existsSync(fullPath);
  }

  async fileExists(filePath: string): Promise<FileExistsResult> {
    const fullPath = this.resolvePath(filePath);
    try {
      const stats = await fs.promises.stat(fullPath);
      return {
        exists: true,
        lastModified: stats.mtime,
      };
    } catch {
      return { exists: false };
    }
  }

  async createWriteStream(
    filePath: string,
    _contentType?: string
  ): Promise<Writable> {
    const fullPath = this.resolvePath(filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return fs.createWriteStream(fullPath);
  }

  async getSignedUrl(
    filePath: string,
    _options?: SignedUrlOptions
  ): Promise<string> {
    // For local development, return a file:// URL or relative path
    const fullPath = this.resolvePath(filePath);
    return `file://${fullPath}`;
  }

  async deleteFile(filePath: string): Promise<boolean> {
    const fullPath = this.resolvePath(filePath);
    try {
      await fs.promises.unlink(fullPath);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async listFiles(prefix: string): Promise<string[]> {
    const fullPath = this.resolvePath(prefix);
    const results: string[] = [];

    try {
      // Use a simple recursive traversal for compatibility
      const traverse = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isFile()) {
            const relativePath = path.relative(this.baseDir, entryPath);
            results.push(relativePath);
          } else if (entry.isDirectory()) {
            await traverse(entryPath);
          }
        }
      };

      await traverse(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return results;
  }

  /**
   * Resolve a relative path to an absolute path
   */
  private resolvePath(filePath: string): string {
    // If already absolute and within base dir, use as-is
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(this.baseDir, filePath);
  }

  /**
   * Get the base directory (useful for debugging)
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
