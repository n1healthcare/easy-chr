/**
 * PDF Extraction Service
 *
 * Converts PDF pages to images and uses Gemini Flash (MARKDOWN_MODEL)
 * to extract content as markdown via vision API.
 *
 * Features:
 * - Page-by-page image extraction from PDFs
 * - Parallel processing (5 pages at a time) with rate limiting
 * - Aggregates all content into a single extracted.md file
 */

import { pdf } from 'pdf-to-img';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { REALM_CONFIG } from '../config.js';
import { withRetry, sleep } from '../common/index.js';
import {
  createGoogleGenAI,
  type BillingContext,
} from '../utils/genai-factory.js';
import type { StoragePort } from '../application/ports/storage.port.js';
import { LegacyPaths } from '../common/storage-paths.js';

// ============================================================================
// Skill Loader
// ============================================================================

function loadPdfExtractorSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'pdf-extractor',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract content after frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[PDFExtraction] Could not load pdf-extractor SKILL.md, using fallback');
    return 'You are a document OCR assistant. Analyze the document image and extract all content in clean Markdown format.';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface PDFExtractionEvent {
  type: 'progress' | 'page_complete' | 'file_complete' | 'error' | 'log';
  data: {
    fileName?: string;
    pageNumber?: number;
    totalPages?: number;
    message?: string;
    error?: string;
  };
}

interface PageExtractionResult {
  fileName: string;
  pageNumber: number;
  markdown: string;
  success: boolean;
  error?: string;
}

// Internal event type for extractSinglePDF (includes result for page_complete events)
interface InternalExtractionEvent {
  type: 'log' | 'page_complete' | 'error';
  data: {
    fileName: string;
    pageNumber?: number;
    totalPages?: number;
    message: string;
    result?: PageExtractionResult;
    error?: string;
  };
}

// ============================================================================
// Constants (now using config for throttle settings)
// ============================================================================

// Legacy constants - now driven by REALM_CONFIG.throttle.pdfExtraction
const getThrottleConfig = () => REALM_CONFIG.throttle.pdfExtraction;
const PDFJS_VERBOSITY_ERRORS_ONLY = 0; // pdf.js VerbosityLevel.ERRORS

// ============================================================================
// Service Implementation
// ============================================================================

export class PDFExtractionService {
  private genai: GoogleGenAI;
  private model: string;
  private extractionPrompt: string;
  private storage: StoragePort;

  constructor(storage: StoragePort, billingContext?: BillingContext) {
    this.storage = storage;
    this.genai = createGoogleGenAI(billingContext);
    this.model = REALM_CONFIG.models.markdown;
    this.extractionPrompt = loadPdfExtractorSkill();
    console.log(`[PDFExtraction] Initialized with model: ${this.model}`);
  }

  /**
   * Extract content from multiple PDFs and save to a single extracted.md file
   *
   * BUFFERED WRITING: Content is collected in memory and written once at the end.
   * This is optimized for cloud storage (S3/GCS) which doesn't support efficient appends.
   *
   * @param pdfPaths - Array of PDF file paths to process
   * @returns AsyncGenerator yielding progress events
   */
  async *extractPDFs(
    pdfPaths: string[]
  ): AsyncGenerator<PDFExtractionEvent, string, unknown> {
    const timestamp = new Date().toISOString();
    const fileNames = pdfPaths.map(p => path.basename(p));

    // Ensure storage is ready
    await this.storage.ensureDir('');

    yield {
      type: 'log',
      data: { message: `Starting extraction of ${pdfPaths.length} PDF(s)...` }
    };

    // Buffer all content in memory for cloud storage compatibility
    const contentBuffer: string[] = [];

    // Add header
    contentBuffer.push(this.buildHeader(timestamp, fileNames));

    let totalPagesExtracted = 0;
    let successCount = 0;
    let extractionErrorCount = 0;

    // Process each PDF file
    for (const pdfPath of pdfPaths) {
      const fileName = path.basename(pdfPath);

      yield {
        type: 'log',
        data: { message: `Processing: ${fileName}`, fileName }
      };

      try {
        // Get page results for this PDF
        for await (const event of this.extractSinglePDF(pdfPath)) {
          if (event.type === 'page_complete' && event.data.result) {
            // Buffer this page's content
            contentBuffer.push(this.formatPageContent(event.data.result));
            totalPagesExtracted++;
            if (event.data.result.success) {
              successCount++;
            }
          }

          if (event.type === 'error') {
            extractionErrorCount++;
            contentBuffer.push(
              this.buildExtractionErrorComment(
                event.data.fileName,
                event.data.error || event.data.message,
                event.data.pageNumber
              )
            );
          }

          // Forward progress events
          const commonEventData = {
            fileName: event.data.fileName,
            pageNumber: event.data.pageNumber,
            totalPages: event.data.totalPages,
            message: event.data.message,
          };

          if (event.type === 'error') {
            yield {
              type: 'error',
              data: {
                ...commonEventData,
                error: event.data.error || event.data.message,
              }
            };
          } else {
            yield {
              type: event.type,
              data: commonEventData,
            };
          }
        }

        yield {
          type: 'file_complete',
          data: { message: `Completed: ${fileName}`, fileName }
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        extractionErrorCount++;
        contentBuffer.push(this.buildExtractionErrorComment(fileName, errorMessage));

        yield {
          type: 'error',
          data: {
            fileName,
            message: `Failed to process ${fileName}`,
            error: errorMessage
          }
        };
      }
    }

    // Add footer with final stats
    contentBuffer.push(this.buildFooter(totalPagesExtracted, successCount, extractionErrorCount));

    // Write all content at once to storage
    const fullContent = contentBuffer.join('');
    await this.storage.writeFile(LegacyPaths.extracted, fullContent, 'text/markdown');
    console.log(`[PDFExtraction] Wrote ${fullContent.length} chars to ${LegacyPaths.extracted}`);

    yield {
      type: 'log',
      data: { message: `Extraction complete. Output: ${LegacyPaths.extracted}` }
    };

    return LegacyPaths.extracted;
  }

  /**
   * Extract content from a single PDF file
   */
  private async *extractSinglePDF(
    pdfPath: string
  ): AsyncGenerator<InternalExtractionEvent> {
    const fileName = path.basename(pdfPath);

    // Convert PDF to images
    const pdfBuffer = await fs.promises.readFile(pdfPath);
    const pages: Buffer[] = [];

    // pdf-to-img returns an async iterable of page images
    const document = await pdf(pdfBuffer, {
      scale: 2.0, // Higher scale for better quality
      docInitParams: {
        // Suppress non-fatal pdf.js warnings (e.g. JPX/OpenJPEG/font warnings) that spam logs.
        verbosity: PDFJS_VERBOSITY_ERRORS_ONLY,
      },
    });

    for await (const page of document) {
      pages.push(page);
    }

    const totalPages = pages.length;
    console.log(`[PDFExtraction] ${fileName}: ${totalPages} pages to process`);

    yield {
      type: 'log',
      data: {
        fileName,
        totalPages,
        message: `Found ${totalPages} pages in ${fileName}`
      }
    };

    // Process pages in batches with rate limiting from config
    const throttle = getThrottleConfig();
    const batchSize = throttle.maxConcurrent;

    for (let batchStart = 0; batchStart < totalPages; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, totalPages);
      const batchPages = pages.slice(batchStart, batchEnd);
      const batchNumber = Math.floor(batchStart / batchSize) + 1;
      const totalBatches = Math.ceil(totalPages / batchSize);

      yield {
        type: 'log',
        data: {
          fileName,
          message: `Processing batch ${batchNumber}/${totalBatches} (pages ${batchStart + 1}-${batchEnd}) [${batchSize} concurrent, ${throttle.delayBetweenBatchesMs}ms delay]`
        }
      };

      // Process batch pages with staggered delays to avoid hammering API
      const batchPromises = batchPages.map(async (pageBuffer, indexInBatch) => {
        // Stagger requests within batch
        if (throttle.delayBetweenRequestsMs > 0 && indexInBatch > 0) {
          await sleep(throttle.delayBetweenRequestsMs * indexInBatch);
        }
        const pageNumber = batchStart + indexInBatch + 1;
        return this.extractPageContent(pageBuffer, fileName, pageNumber);
      });

      const batchResults = await Promise.all(batchPromises);

      // Yield results for each page
      for (const result of batchResults) {
        yield {
          type: 'page_complete',
          data: {
            fileName,
            pageNumber: result.pageNumber,
            totalPages,
            message: result.success
              ? `Page ${result.pageNumber}/${totalPages} extracted`
              : `Page ${result.pageNumber}/${totalPages} failed: ${result.error}`,
            result,
          }
        };

        if (!result.success) {
          yield {
            type: 'error',
            data: {
              fileName,
              pageNumber: result.pageNumber,
              totalPages,
              message: `Extraction failed for page ${result.pageNumber}/${totalPages}`,
              error: result.error || 'Unknown extraction error',
            }
          };
        }
      }

      // Add delay between batches to avoid rate limits (except for last batch)
      if (batchEnd < totalPages && throttle.delayBetweenBatchesMs > 0) {
        await sleep(throttle.delayBetweenBatchesMs);
      }
    }
  }

  /**
   * Extract content from a single page image using Gemini Vision
   */
  private async extractPageContent(
    pageBuffer: Buffer,
    fileName: string,
    pageNumber: number
  ): Promise<PageExtractionResult> {
    try {
      const base64Image = pageBuffer.toString('base64');

      const response = await withRetry(
        () => this.genai.models.generateContent({
          model: this.model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: base64Image,
                  },
                },
                {
                  text: this.extractionPrompt,
                },
              ],
            },
          ],
        }),
        { ...REALM_CONFIG.retry.vision, operationName: `PDFExtraction.page${pageNumber}` }
      );

      const markdown = response.text || '';

      console.log(`[PDFExtraction] ${fileName} page ${pageNumber}: extracted ${markdown.length} chars`);

      return {
        fileName,
        pageNumber,
        markdown,
        success: true,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PDFExtraction] ${fileName} page ${pageNumber} failed:`, errorMessage);

      return {
        fileName,
        pageNumber,
        markdown: `[Extraction failed: ${errorMessage}]`,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Build the header content for extracted.md
   */
  private buildHeader(timestamp: string, fileNames: string[]): string {
    let header = '';
    header += `<!-- START EXTRACTION -->\n`;
    header += `<!-- Extraction Date: ${timestamp} -->\n`;
    header += `<!-- Files Processed: ${fileNames.join(', ')} -->\n`;
    header += `<!-- Note: Content is buffered and written in a single operation -->\n\n`;
    header += `---\n\n`;
    return header;
  }

  /**
   * Format a single page's content
   */
  private formatPageContent(result: PageExtractionResult): string {
    let content = '';
    content += `## [${result.fileName}] - Page ${result.pageNumber}\n\n`;
    content += result.markdown.trim();
    content += '\n\n---\n\n';
    return content;
  }

  /**
   * Build the footer content with final stats
   */
  private buildFooter(totalPages: number, successCount: number, extractionErrorCount: number): string {
    let footer = '';
    footer += `<!-- END EXTRACTION -->\n`;
    footer += `<!-- Total Pages: ${totalPages} | Successful: ${successCount} -->\n`;
    footer += `<!-- Extraction Errors: ${extractionErrorCount} -->\n`;
    footer += `<!-- Extraction completed at: ${new Date().toISOString()} -->\n`;
    return footer;
  }

  /**
   * Build a structured extraction failure HTML comment.
   */
  private buildExtractionErrorComment(fileName: string, errorMessage: string, pageNumber?: number): string {
    const safeFileName = fileName
      .replace(/\s+/g, ' ')
      .replace(/--/g, '- -')
      .replace(/"/g, '\'')
      .trim();
    const safeMessage = errorMessage
      .replace(/\s+/g, ' ')
      .replace(/--/g, '- -')
      .replace(/"/g, '\'')
      .trim();
    const pageSegment = pageNumber !== undefined ? ` page="${pageNumber}"` : '';
    return `<!-- EXTRACTION_ERROR file="${safeFileName}"${pageSegment} message="${safeMessage}" -->\n`;
  }
}
