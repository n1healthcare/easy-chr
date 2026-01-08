import { LLMClientPort } from '../ports/llm-client.port.js';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../../config.js';

export class ExtractDocumentUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  /**
   * Extracts content from a raw file (PDF, etc.) into a clean Markdown file with metadata.
   * @param filePath The path to the uploaded raw file.
   * @param outputDir The directory where the markdown file should be saved.
   * @returns The path to the generated markdown file.
   */
  async execute(filePath: string, outputDir: string): Promise<string> {
    const fileName = path.basename(filePath);
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const outputPath = path.join(outputDir, `${safeName}.md`);
    
    // Create a unique session for this extraction to avoid context pollution
    const sessionId = `extract-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    console.log(`Librarian: Extracting ${fileName} using ${REALM_CONFIG.models.markdown}...`);

    const systemPrompt = `
      You are an expert Data Librarian and OCR Specialist.
      
      Your task is to convert the attached document into a clean, structured Markdown file.
      
      RULES:
      1.  **Metadata Header:** You MUST start with a YAML frontmatter block containing:
          -   original_filename: "${fileName}"
          -   document_date: (Extract the primary date of the document, YYYY-MM-DD. If unknown, use "Unknown")
          -   document_type: (e.g., "Blood Test", "Financial Statement", "Medical Report", "Receipt")
          -   patient_name: (If applicable)
          -   provider_name: (e.g., Lab name, Bank name)
      
      2.  **Content Extraction:**
          -   Transcribe all text accurately.
          -   Represent tables using Markdown table syntax.
          -   Do not summarize. Extract EVERYTHING.
          -   If there are handwritten notes, transcribe them in *italics* and label them [Handwritten].
          -   For images/graphs, describe them in detail (e.g., "Graph showing Creatinine trend rising from 1.2 to 1.5").
      
      3.  **Format:**
          -   Use strictly standard Markdown.
          -   No conversational filler ("Here is the file..."). Just the content.

      **CRITICAL INSTRUCTION - THINKING PROCESS:**
      1.  First, THINK about the document structure, date formats, and potential OCR errors.
      2.  When you are ready to output the final Markdown, you MUST output the separator: \`---END_OF_THOUGHT---\`.
      3.  Everything AFTER that separator will be saved as the final file.
    `;

    // We use the configured Markdown Model (e.g., Flash)
    const stream = await this.llmClient.sendMessageStream(
      systemPrompt, 
      sessionId, 
      [filePath], 
      { model: REALM_CONFIG.models.markdown }
    );

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk;
    }

    // Split thinking from content
    let finalContent = fullResponse;
    if (fullResponse.includes('---END_OF_THOUGHT---')) {
      const parts = fullResponse.split('---END_OF_THOUGHT---');
      // parts[0] is the thinking (we discard or log it), parts[1] is the content
      if (parts.length > 1) {
        finalContent = parts[1].trim();
        console.log(`[Librarian Thinking]: ${parts[0].substring(0, 200)}...`); // Log snippet of thought
      }
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, finalContent);
    console.log(`Librarian: Saved extraction to ${outputPath}`);

    return outputPath;
  }
}
