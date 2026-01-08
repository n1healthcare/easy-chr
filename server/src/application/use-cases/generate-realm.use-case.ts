import { LLMClientPort } from '../ports/llm-client.port.js';
import { ExtractDocumentUseCase } from './extract-document.use-case.js';
import { AnalyzeDocumentsUseCase } from './analyze-documents.use-case.js';
import { SynthesizeReportUseCase } from './synthesize-report.use-case.js';
import { REALM_CONFIG } from '../../config.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type RealmGenerationEvent = 
  | { type: 'step', name: string, status: 'running' | 'completed' | 'failed' }
  | { type: 'log', message: string }
  | { type: 'stream', content: string }
  | { type: 'result', url: string };

export class GenerateRealmUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async *execute(prompt: string, uploadedFilePaths: string[]): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    const realmId = uuidv4();
    const realmDir = path.join(process.cwd(), 'storage', 'realms', realmId);
    
    if (!fs.existsSync(realmDir)) {
      fs.mkdirSync(realmDir, { recursive: true });
    }

    const sessionId = `realm-gen-${realmId}`;
    console.log(`Generating realm ${realmId} for files ${uploadedFilePaths.join(', ')}...`);

    // PHASE 0: LIBRARIAN (File Extraction)
    yield { type: 'step', name: 'Librarian Agent', status: 'running' };
    const librarian = new ExtractDocumentUseCase(this.llmClient);
    const sourceDocsDir = path.join(realmDir, 'source_documents');
    const extractedFilePaths: string[] = [];

    for (const filePath of uploadedFilePaths) {
      const fileName = path.basename(filePath);
      yield { type: 'log', message: `Extracting content from ${fileName}...` };
      
      try {
        const mdPath = await librarian.execute(filePath, sourceDocsDir);
        extractedFilePaths.push(mdPath);
        // We assume success if no error, user just sees next file extraction log
      } catch (error) {
        console.error(`Failed to extract ${fileName}:`, error);
        yield { type: 'log', message: `❌ Failed to extract ${fileName}: ${error}` };
      }
    }
    yield { type: 'step', name: 'Librarian Agent', status: 'completed' };

    // Use the extracted markdown files if available, otherwise fall back to originals
    const filesToAnalyze = extractedFilePaths.length > 0 ? extractedFilePaths : uploadedFilePaths;

    // PHASE 1: SPECIALISTS (Sequential Analysis)
    yield { type: 'step', name: 'Specialist Agents', status: 'running' };
    yield { type: 'log', message: 'Running sequential analysis (Facts, Trends, Relationships)...' };
    
    const specialists = new AnalyzeDocumentsUseCase(this.llmClient);
    try {
      for await (const log of specialists.execute(realmDir, filesToAnalyze, prompt)) {
        yield { type: 'log', message: log };
      }
      yield { type: 'step', name: 'Specialist Agents', status: 'completed' };
    } catch (error) {
      console.error("Specialists failed:", error);
      yield { type: 'log', message: `❌ Specialists failed: ${error}` };
      yield { type: 'step', name: 'Specialist Agents', status: 'failed' };
      return; // STOP EXECUTION
    }

    // PHASE 2: SYNTHESIZER (Master Report)
    yield { type: 'step', name: 'Synthesizer Agent', status: 'running' };
    yield { type: 'log', message: 'Compiling Master Report...' };
    
    const synthesizer = new SynthesizeReportUseCase(this.llmClient);
    let reportPath = '';
    try {
      reportPath = await synthesizer.execute(realmDir, prompt);
      yield { type: 'step', name: 'Synthesizer Agent', status: 'completed' };
    } catch (error) {
      console.error("Synthesizer failed:", error);
      yield { type: 'log', message: `❌ Synthesizer failed: ${error}` };
      yield { type: 'step', name: 'Synthesizer Agent', status: 'failed' };
      return; // STOP EXECUTION
    }

    // PHASE 3: BUILDER (HTML Generation)
    // The Builder now looks at the Report (or Specialists output if Report failed)
    const filesForBuilder = reportPath ? [reportPath] : filesToAnalyze;
    
    yield { type: 'step', name: 'Builder Agent', status: 'running' };
    yield { type: 'log', message: `Constructing Realm HTML from ${path.basename(filesForBuilder[0])}...` };

    const builderPrompt = `
      You are an elite Frontend Architect and Data Visualization Expert (The Builder).
      
      **User's Vision:** "${prompt}"
      (Ensure the dashboard design and emphasis align with this vision).

      **Goal:** Transform the provided Master Report (Markdown) into a "Personal Realm" - a stunning, immersive, single-page HTML dashboard.
      
      **Design Philosophy:**
      *   **Layout:** Single long-scrolling page with a sticky, glassmorphism sidebar/header navigation. No tabs.
      *   **Theme:** "Cyberpunk Professional" / Modern Dark Mode. Deep slate/black backgrounds, vibrant gradients (purple-to-blue, teal-to-emerald) for accents, white text.
      *   **Components:** Glassmorphism cards (translucent backgrounds with blurs), glowing borders, modern typography.
      *   **Visuals:** Every section MUST have an icon (FontAwesome). Every numerical dataset MUST be visualized (Chart.js).
      
      **CRITICAL CONTENT RULES (ZERO DATA LOSS POLICY):**
      1.  **ZERO DATA LOSS:** Explicitly state that every list item, every question, and every recommendation in the markdown MUST appear in the HTML.
          *   *Example:* If the report lists 3 specific questions for the doctor, you MUST create a "Physician Strategy" section with those exact 3 questions.
          *   *Example:* If the report lists 8 supplements, the HTML must display 8 supplement cards. 6 is a failure.
      2.  **VERBATIM TRANSFER:** You are a mirror. Sections like "Questions for Your Doctor" or "Q&A" must be copied word-for-word. Do NOT summarize or "gist" it.
      3.  **VISUAL COMPLETENESS:** Ensure that if a system (e.g., "Neuro-Cognitive" or "Energy") is mentioned in the text, it MUST have a corresponding visual element or section card. Do not skip a system just because it is short.
      
      **Strict Technical Requirements:**
      1.  **Output:** STRICTLY valid HTML5 containing CSS and JS. Start with \`<!DOCTYPE html>\`.
      2.  **Libraries (Use CDNs):**
          *   Tailwind CSS (v3.x)
          *   FontAwesome (Free v6.x)
          *   Chart.js (v4.x)
          *   Google Fonts (Inter or Roboto)
      3.  **Mandatory Structure:**
          *   **Hero Section:** Title, Executive Summary, and a "Key Vitals" grid.
          *   **Patient Advocacy:** A dedicated section for "Questions for Your Doctor" (Verbatim).
          *   **Timeline:** Vertical timeline component for the health journey.
          *   **Deep Dive Sections:** Create distinct sections for EACH system analyzed (Metabolic, Gut, Neuro, etc.).
          *   **Action Plan:** Detailed dietary, lifestyle, and supplementation grids (Full Protocol).
      4.  **Charts:**
          *   Auto-detect data in the text (tables, lists of numbers).
          *   Generate \`<canvas>\` elements and write the corresponding Chart.js configuration scripts at the bottom of the body.
          *   Use "doughnut" for composition, "line" for trends, "bar" for comparisons. Colors should match the dark theme (neon colors).
      5.  **Interactivity:**
          *   Smooth scrolling navigation.
          *   Hover effects on cards (scale up, glow).
          *   Chart tooltips. 
          
      **Response Format:**
      ONLY return the raw HTML code. Do not wrap in markdown blocks if possible, but if you do, I will strip them. NO PREAMBLE.
    `;

    const stream = await this.llmClient.sendMessageStream(
      builderPrompt, 
      sessionId, 
      filesForBuilder, 
      { model: REALM_CONFIG.models.html }
    );

    let htmlBuffer = '';
    let isCollectingHtml = false;
    // We look for the doctype or html tag to start collecting
    // Regex for loose matching start of HTML
    const htmlStartRegex = /<!DOCTYPE html>|<html/i;

    for await (const chunk of stream) {
      if (isCollectingHtml) {
        htmlBuffer += chunk;
      } else {
        const match = chunk.match(htmlStartRegex);
        if (match) {
          isCollectingHtml = true;
          const index = match.index!;
          const thoughtPart = chunk.substring(0, index);
          const htmlPart = chunk.substring(index);
          
          if (thoughtPart.trim()) {
            yield { type: 'stream', content: thoughtPart };
          }
          htmlBuffer += htmlPart;
        } else {
          // If no HTML start tag yet, yield as stream
          yield { type: 'stream', content: chunk };
        }
      }
    }

    // Cleanup: Strip markdown code blocks if the model disobeyed
    htmlBuffer = htmlBuffer.replace(/^```html\s*/, '').replace(/```$/, '');
    
    // If buffer is empty, something went wrong (model didn't output HTML)
    if (!htmlBuffer.trim()) {
        console.warn("No HTML content detected in response!");
    }

    const indexPath = path.join(realmDir, 'index.html');
    fs.writeFileSync(indexPath, htmlBuffer);

    console.log(`Realm generated at ${indexPath}`);

    yield { type: 'result', url: `/realms/${realmId}/index.html` };
  }
}
    
