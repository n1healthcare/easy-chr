import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'stream';

import { PDFExtractionService } from '../services/pdf-extraction.service.js';
import { LegacyPaths } from '../common/storage-paths.js';
import type { StoragePort, FileExistsResult, SignedUrlOptions } from '../application/ports/storage.port.js';

vi.mock('../utils/genai-factory.js', () => ({
  createGoogleGenAI: vi.fn(() => ({
    models: {
      generateContent: vi.fn(),
    },
  })),
}));

class InMemoryStorage implements StoragePort {
  private readonly files = new Map<string, Buffer>();

  async writeFile(path: string, content: string | Buffer): Promise<string> {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    this.files.set(path, data);
    return path;
  }

  async readFile(path: string): Promise<Buffer> {
    const value = this.files.get(path);
    if (!value) {
      throw new Error(`Missing file: ${path}`);
    }
    return value;
  }

  async readFileAsString(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const value = await this.readFile(path);
    return value.toString(encoding);
  }

  async appendFile(path: string, content: string): Promise<void> {
    const existing = this.files.get(path) || Buffer.from('', 'utf-8');
    this.files.set(path, Buffer.concat([existing, Buffer.from(content, 'utf-8')]));
  }

  async ensureDir(_path: string): Promise<void> {
    // no-op
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async fileExists(path: string): Promise<FileExistsResult> {
    return { exists: this.files.has(path) };
  }

  async createWriteStream(path: string): Promise<Writable> {
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        this.files.set(path, Buffer.concat(chunks));
        callback();
      },
    });
  }

  async getSignedUrl(path: string, _options?: SignedUrlOptions): Promise<string> {
    return `memory://${path}`;
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async listFiles(prefix: string): Promise<string[]> {
    return Array.from(this.files.keys()).filter((path) => path.startsWith(prefix));
  }
}

describe('PDFExtractionService', () => {
  it('stores extraction errors separately and keeps extracted output clean', async () => {
    const storage = new InMemoryStorage();
    const service = new PDFExtractionService(storage);

    (service as any).extractSinglePDF = async function* (_pdfPath: string) {
      yield {
        type: 'page_complete',
        data: {
          fileName: 'report.pdf',
          pageNumber: 1,
          totalPages: 2,
          message: 'Page 1/2 extracted',
          result: {
            fileName: 'report.pdf',
            pageNumber: 1,
            markdown: 'Page one markdown',
            success: true,
          },
        },
      };
      yield {
        type: 'error',
        data: {
          fileName: 'report.pdf',
          pageNumber: 2,
          totalPages: 2,
          message: 'Extraction failed for page 2/2',
          error: 'timed out',
        },
      };
    };

    const extraction = service.extractPDFs(['/tmp/report.pdf']);
    let state = await extraction.next();
    while (!state.done) {
      state = await extraction.next();
    }
    const summary = state.value;

    expect(summary.outputPath).toBe(LegacyPaths.extracted);
    expect(summary.totalPagesExtracted).toBe(1);
    expect(summary.successCount).toBe(1);
    expect(summary.extractionErrorCount).toBe(1);
    expect(summary.extractionErrors).toEqual([
      {
        fileName: 'report.pdf',
        pageNumber: 2,
        message: 'timed out',
      },
    ]);

    const extractedContent = await storage.readFileAsString(LegacyPaths.extracted);
    expect(extractedContent).toContain('## [report.pdf] - Page 1');
    expect(extractedContent).not.toContain('EXTRACTION_ERROR');
    expect(extractedContent).not.toContain('<!-- ERROR:');

    const errorArtifact = await storage.readFileAsString(LegacyPaths.extractionErrors);
    expect(JSON.parse(errorArtifact)).toEqual(summary.extractionErrors);
  });
});
