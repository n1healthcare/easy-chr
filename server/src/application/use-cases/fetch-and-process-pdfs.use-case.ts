import { MarkdownFetcherPort } from '../ports/markdown-fetcher.port.js';
import { AgenticDoctorUseCase } from './agentic-doctor.use-case.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class FetchAndProcessPDFsUseCase {
  constructor(
    private readonly markdownFetcher: MarkdownFetcherPort,
    private readonly agenticDoctor: AgenticDoctorUseCase
  ) {}

  async *execute(userId: string, prompt: string) {
    // Step 1: Fetch pre-extracted markdowns from N1 API
    yield {
      type: 'thought',
      content: `Fetching pre-extracted markdowns for user: ${userId}...`,
    };

    const fetchResult = await this.markdownFetcher.fetchMarkdownsForUser(userId);
    const { markdowns, failedRecordIds } = fetchResult;

    // If nothing at all came back, we can't proceed
    if (markdowns.length === 0 && failedRecordIds.length === 0) {
      yield {
        type: 'error',
        content: 'No completed records found for this user',
      };
      throw new Error('No records available');
    }

    yield {
      type: 'thought',
      content: `Downloaded ${markdowns.length} markdown(s), ${failedRecordIds.length} record(s) need PDF fallback.`,
    };

    // Step 2: Assemble pre-extracted content from successful markdowns
    const preExtractedContent = markdowns.length > 0
      ? markdowns
          .map(md => `## [${md.fileName.replace(/]/g, '')}]\n\n${md.markdownContent}`)
          .join('\n\n---\n\n')
      : '';

    // Step 3: Route based on whether we have failures
    if (failedRecordIds.length === 0) {
      // Fast path: all records had markdown, skip OCR entirely
      yield {
        type: 'thought',
        content: `All records have markdown. Skipping OCR. Starting analysis pipeline...`,
      };

      const doctorGenerator = this.agenticDoctor.executeWithExtractedContent(
        prompt,
        preExtractedContent,
      );

      for await (const event of doctorGenerator) {
        yield event;
      }
    } else {
      // Fallback path: some records need PDF + Vision OCR
      yield {
        type: 'thought',
        content: `Downloading ${failedRecordIds.length} PDF(s) for Vision OCR fallback...`,
      };

      let pdfBuffers: Array<{ buffer: Buffer; fileName: string; recordId: string }>;
      try {
        pdfBuffers = await this.markdownFetcher.fetchPDFsByRecordIds(userId, failedRecordIds);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        yield {
          type: 'thought',
          content: `Warning: Failed to fetch fallback PDFs: ${message}. Continuing with markdown-only content.`,
        };
        pdfBuffers = [];
      }

      if (pdfBuffers.length === 0 && markdowns.length === 0) {
        yield {
          type: 'error',
          content: 'No content available: markdown fetch returned nothing and PDF fallback failed',
        };
        throw new Error('No records available');
      }

      if (pdfBuffers.length === 0) {
        // PDF fallback failed but we have some markdowns — proceed without OCR
        yield {
          type: 'thought',
          content: `PDF fallback yielded 0 files. Proceeding with ${markdowns.length} markdown(s) only.`,
        };

        const doctorGenerator = this.agenticDoctor.executeWithExtractedContent(
          prompt,
          preExtractedContent,
        );

        for await (const event of doctorGenerator) {
          yield event;
        }
      } else {
        // Save PDFs to temp directory for OCR processing
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'n1-pdf-fallback-'));
        const pdfFilePaths: string[] = [];

        try {
          for (const { buffer, fileName } of pdfBuffers) {
            const filePath = path.join(tempDir, fileName);
            await fs.promises.writeFile(filePath, buffer);
            pdfFilePaths.push(filePath);
          }

          yield {
            type: 'thought',
            content: `Saved ${pdfFilePaths.length} PDF(s) to temp. Running mixed-source pipeline (${markdowns.length} markdown + ${pdfFilePaths.length} OCR)...`,
          };

          const doctorGenerator = this.agenticDoctor.executeWithMixedSources(
            prompt,
            preExtractedContent,
            pdfFilePaths,
          );

          for await (const event of doctorGenerator) {
            yield event;
          }
        } finally {
          // Clean up temp files
          try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup
          }
        }
      }
    }
  }
}
