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
  type: 'log' | 'page_complete';
  data: {
    fileName: string;
    pageNumber?: number;
    totalPages?: number;
    message: string;
    result?: PageExtractionResult;
  };
}

// ============================================================================
// Constants
// ============================================================================

const PAGES_PER_BATCH = 5;
const BATCH_DELAY_MS = 1000; // 1 second delay between batches to avoid rate limits

const EXTRACTION_PROMPT = `You are a document OCR assistant. Analyze the document image and extract all content in clean Markdown format.

- For text: Extract the text in the image.
- For tables: Parse the table in the image into clean Markdown format.
- For equations: Identify the formula in the image and represent it using LaTeX format.`;

// ============================================================================
// Service Implementation
// ============================================================================

export class PDFExtractionService {
  private genai: GoogleGenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }

    // Support custom base URL for proxy
    const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL;

    this.genai = new GoogleGenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });

    this.model = REALM_CONFIG.models.markdown;
    console.log(`[PDFExtraction] Initialized with model: ${this.model}`);
  }

  /**
   * Extract content from multiple PDFs and save to a single extracted.md file
   *
   * INCREMENTAL WRITING: Content is appended to the file as each page completes,
   * so progress is preserved even if extraction crashes mid-way.
   *
   * @param pdfPaths - Array of PDF file paths to process
   * @param outputDir - Directory to save the extracted.md file
   * @returns AsyncGenerator yielding progress events
   */
  async *extractPDFs(
    pdfPaths: string[],
    outputDir: string
  ): AsyncGenerator<PDFExtractionEvent, string, unknown> {
    const timestamp = new Date().toISOString();
    const fileNames = pdfPaths.map(p => path.basename(p));

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'extracted.md');

    yield {
      type: 'log',
      data: { message: `Starting extraction of ${pdfPaths.length} PDF(s)...` }
    };

    // Write header immediately
    await this.writeHeader(outputPath, timestamp, fileNames);

    let totalPagesExtracted = 0;
    let successCount = 0;

    // Process each PDF file
    for (const pdfPath of pdfPaths) {
      const fileName = path.basename(pdfPath);

      yield {
        type: 'log',
        data: { message: `Processing: ${fileName}`, fileName }
      };

      try {
        // Get page results for this PDF and write incrementally
        for await (const event of this.extractSinglePDF(pdfPath)) {
          if (event.type === 'page_complete' && event.data.result) {
            // Write this page immediately to the file
            await this.appendPageContent(outputPath, event.data.result);
            totalPagesExtracted++;
            if (event.data.result.success) {
              successCount++;
            }
          }

          // Forward progress events
          yield {
            type: event.type,
            data: {
              fileName: event.data.fileName,
              pageNumber: event.data.pageNumber,
              totalPages: event.data.totalPages,
              message: event.data.message,
            }
          };
        }

        yield {
          type: 'file_complete',
          data: { message: `Completed: ${fileName}`, fileName }
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Write error note to file so we know extraction failed for this file
        await fs.promises.appendFile(
          outputPath,
          `\n<!-- ERROR: Failed to process ${fileName}: ${errorMessage} -->\n\n`,
          'utf-8'
        );

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

    // Write footer with final stats
    await this.writeFooter(outputPath, totalPagesExtracted, successCount);

    yield {
      type: 'log',
      data: { message: `Extraction complete. Output: ${outputPath}` }
    };

    return outputPath;
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
    const document = await pdf(pdfBuffer, { scale: 2.0 }); // Higher scale for better quality

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

    // Process pages in batches of 5 (parallel within batch)
    const results: PageExtractionResult[] = [];

    for (let batchStart = 0; batchStart < totalPages; batchStart += PAGES_PER_BATCH) {
      const batchEnd = Math.min(batchStart + PAGES_PER_BATCH, totalPages);
      const batchPages = pages.slice(batchStart, batchEnd);
      const batchNumber = Math.floor(batchStart / PAGES_PER_BATCH) + 1;
      const totalBatches = Math.ceil(totalPages / PAGES_PER_BATCH);

      yield {
        type: 'log',
        data: {
          fileName,
          message: `Processing batch ${batchNumber}/${totalBatches} (pages ${batchStart + 1}-${batchEnd})`
        }
      };

      // Process batch pages in parallel
      const batchPromises = batchPages.map((pageBuffer, indexInBatch) => {
        const pageNumber = batchStart + indexInBatch + 1;
        return this.extractPageContent(pageBuffer, fileName, pageNumber);
      });

      const batchResults = await Promise.all(batchPromises);

      // Yield results for each page
      for (const result of batchResults) {
        results.push(result);

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
      }

      // Add delay between batches to avoid rate limits (except for last batch)
      if (batchEnd < totalPages) {
        await this.delay(BATCH_DELAY_MS);
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

      const response = await this.genai.models.generateContent({
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
                text: EXTRACTION_PROMPT,
              },
            ],
          },
        ],
      });

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
   * Write the header to the extracted.md file (overwrites if exists)
   */
  private async writeHeader(
    outputPath: string,
    timestamp: string,
    fileNames: string[]
  ): Promise<void> {
    let header = '';
    header += `<!-- START EXTRACTION -->\n`;
    header += `<!-- Extraction Date: ${timestamp} -->\n`;
    header += `<!-- Files Processed: ${fileNames.join(', ')} -->\n`;
    header += `<!-- Note: Content is written incrementally as pages are extracted -->\n\n`;
    header += `---\n\n`;

    // Write (overwrite) the file with the header
    await fs.promises.writeFile(outputPath, header, 'utf-8');
    console.log(`[PDFExtraction] Header written to: ${outputPath}`);
  }

  /**
   * Append a single page's content to the extracted.md file
   */
  private async appendPageContent(
    outputPath: string,
    result: PageExtractionResult
  ): Promise<void> {
    let content = '';
    content += `## [${result.fileName}] - Page ${result.pageNumber}\n\n`;
    content += result.markdown.trim();
    content += '\n\n---\n\n';

    await fs.promises.appendFile(outputPath, content, 'utf-8');
    console.log(`[PDFExtraction] Appended page ${result.pageNumber} from ${result.fileName}`);
  }

  /**
   * Write the footer with final stats to the extracted.md file
   */
  private async writeFooter(
    outputPath: string,
    totalPages: number,
    successCount: number
  ): Promise<void> {
    let footer = '';
    footer += `<!-- END EXTRACTION -->\n`;
    footer += `<!-- Total Pages: ${totalPages} | Successful: ${successCount} -->\n`;
    footer += `<!-- Extraction completed at: ${new Date().toISOString()} -->\n`;

    await fs.promises.appendFile(outputPath, footer, 'utf-8');
    console.log(`[PDFExtraction] Footer written. Total: ${totalPages} pages, ${successCount} successful`);
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
