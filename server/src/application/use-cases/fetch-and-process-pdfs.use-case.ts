import { writeFile } from 'fs/promises';
import path from 'path';
import fs from 'fs';
import { PDFFetcherPort } from '../ports/pdf-fetcher.port.js';
import { AgenticDoctorUseCase } from './agentic-doctor.use-case.js';

export class FetchAndProcessPDFsUseCase {
  constructor(
    private readonly pdfFetcher: PDFFetcherPort,
    private readonly agenticDoctor: AgenticDoctorUseCase
  ) {}

  async *execute(userId: string, prompt: string) {
    // Step 1: Fetch PDFs from N1 API
    yield {
      type: 'thought',
      content: `Fetching PDFs for user: ${userId}...`,
    };

    let pdfs;
    try {
      pdfs = await this.pdfFetcher.fetchPDFsForUser(userId);
    } catch (error: any) {
      yield {
        type: 'error',
        content: `Failed to fetch PDFs: ${error.message}`,
      };
      throw error;
    }

    if (pdfs.length === 0) {
      yield {
        type: 'error',
        content: 'No completed PDFs found for this user',
      };
      throw new Error('No PDFs available');
    }

    yield {
      type: 'thought',
      content: `Found ${pdfs.length} PDF(s). Saving to temporary storage...`,
    };

    // Step 2: Save PDFs to temporary storage
    const inputDir = path.join(process.cwd(), 'storage', 'input');
    if (!fs.existsSync(inputDir)) {
      fs.mkdirSync(inputDir, { recursive: true });
    }

    const filePaths: string[] = [];
    for (const pdf of pdfs) {
      const filePath = path.join(inputDir, pdf.fileName);
      await writeFile(filePath, pdf.buffer);
      filePaths.push(filePath);
    }

    yield {
      type: 'thought',
      content: `Saved ${filePaths.length} file(s). Starting analysis pipeline...`,
    };

    // Step 3: Process through the existing Agentic Doctor pipeline
    const doctorGenerator = this.agenticDoctor.execute(prompt, filePaths);

    for await (const event of doctorGenerator) {
      yield event;
    }
  }
}
