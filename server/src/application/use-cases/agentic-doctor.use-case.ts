/**
 * AgenticDoctorUseCase - PDF Extraction Pipeline
 *
 * Extracts content from uploaded documents (PDFs via Vision OCR, text files directly)
 * and saves to extracted.md for downstream processing.
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

import { LLMClientPort } from '../ports/llm-client.port.js';
import { readFileWithEncoding } from '../../../vendor/gemini-cli/packages/core/src/utils/fileUtils.js';
import { PDFExtractionService } from '../../services/pdf-extraction.service.js';
import type { RealmGenerationEvent } from '../../domain/types.js';

export type { RealmGenerationEvent };

// ============================================================================
// Use Case Implementation
// ============================================================================

export class AgenticDoctorUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async initialize(): Promise<void> {
    // No initialization needed for now
  }

  async *execute(
    prompt: string,
    uploadedFilePaths: string[],
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    const sessionId = uuidv4();
    const storageDir = path.join(process.cwd(), 'storage');

    // Ensure storage directory exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    console.log(`[AgenticDoctor] Session ${sessionId}: Processing ${uploadedFilePaths.length} files...`);

    // ========================================================================
    // Document Extraction Phase
    // PDFs: Vision OCR → Markdown
    // Other files: Direct text extraction
    // ========================================================================
    yield { type: 'step', name: 'Document Extraction', status: 'running' };
    yield { type: 'log', message: `Processing ${uploadedFilePaths.length} document(s)...` };

    // Separate PDFs from other files
    const pdfFiles: string[] = [];
    const otherFiles: string[] = [];

    for (const filePath of uploadedFilePaths) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.pdf') {
        pdfFiles.push(filePath);
      } else {
        otherFiles.push(filePath);
      }
    }

    let allExtractedContent = '';

    // Process PDFs using Vision OCR
    if (pdfFiles.length > 0) {
      yield { type: 'log', message: `Extracting ${pdfFiles.length} PDF(s) using Gemini Vision...` };

      const pdfExtractor = new PDFExtractionService();

      try {
        for await (const event of pdfExtractor.extractPDFs(pdfFiles, storageDir)) {
          if (event.type === 'log' || event.type === 'progress') {
            yield { type: 'log', message: event.data.message || '' };
          } else if (event.type === 'page_complete') {
            yield {
              type: 'log',
              message: `[${event.data.fileName}] Page ${event.data.pageNumber}/${event.data.totalPages} extracted`
            };
          } else if (event.type === 'error') {
            yield { type: 'log', message: `Warning: ${event.data.message}` };
          }
        }

        const extractedPath = path.join(storageDir, 'extracted.md');
        if (fs.existsSync(extractedPath)) {
          allExtractedContent = await fs.promises.readFile(extractedPath, 'utf-8');
          console.log(`[AgenticDoctor] PDF extraction complete: ${allExtractedContent.length} chars`);
          yield { type: 'log', message: `PDF extraction complete (${pdfFiles.length} files)` };
        } else {
          yield { type: 'log', message: 'Warning: PDF extraction produced no output' };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[AgenticDoctor] PDF extraction failed:', errorMessage);
        yield { type: 'log', message: `PDF extraction failed: ${errorMessage}` };
      }
    }

    // Process non-PDF files (append to extracted content)
    for (const filePath of otherFiles) {
      try {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        yield { type: 'log', message: `Processing: ${fileName}...` };

        let textContent: string;

        if (['.txt', '.md', '.csv', '.json', '.xml', '.html'].includes(ext)) {
          textContent = await readFileWithEncoding(filePath);
        } else {
          try {
            textContent = await readFileWithEncoding(filePath);
          } catch {
            console.warn(`[AgenticDoctor] Could not read ${fileName} as text, skipping`);
            yield { type: 'log', message: `Warning: Skipping unsupported file type: ${fileName}` };
            continue;
          }
        }

        if (!textContent || textContent.trim().length === 0) {
          yield { type: 'log', message: `Warning: Empty content in ${fileName}, skipping` };
          continue;
        }

        // Append to extracted content
        allExtractedContent += `\n\n## [${fileName}]\n\n${textContent}`;
        yield { type: 'log', message: `Processed: ${fileName}` };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        yield { type: 'log', message: `Warning: Could not process ${path.basename(filePath)}: ${errorMessage}` };
      }
    }

    // Save final extracted.md
    const extractedPath = path.join(storageDir, 'extracted.md');
    await fs.promises.writeFile(extractedPath, allExtractedContent, 'utf-8');

    yield { type: 'step', name: 'Document Extraction', status: 'completed' };

    if (!allExtractedContent || allExtractedContent.trim().length === 0) {
      yield { type: 'log', message: 'Error: No content could be extracted from documents.' };
      yield { type: 'step', name: 'Document Extraction', status: 'failed' };
      return;
    }

    console.log(`[AgenticDoctor] Total extracted content: ${allExtractedContent.length} chars`);
    yield { type: 'log', message: `Extraction complete. Output: ${extractedPath}` };
    yield { type: 'result', extractedPath };

    // ========================================================================
    // TODO: Next steps will be built here
    // - Pass extracted.md to gemini-cli for analysis
    // - Use built-in a2a and tools
    // ========================================================================
  }
}
