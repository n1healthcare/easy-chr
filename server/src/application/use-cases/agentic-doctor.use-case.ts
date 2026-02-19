/**
 * AgenticDoctorUseCase - Medical Document Analysis Pipeline
 *
 * 9-Phase Pipeline:
 * Phase 1: Document Extraction - PDFs via Vision OCR, text files directly → extracted.md
 * Phase 2: Medical Analysis - LLM with medical-analysis skill → analysis.md (includes cross-system analysis)
 * Phase 3: Research - Web search to validate claims with external sources → research.json
 * Phase 4: Data Structuring - LLM extracts chart-ready JSON (SOURCE OF TRUTH) → structured_data.json
 * Phase 5: Validation - LLM validates structured_data.json completeness → validation.md (with correction loop)
 * Phase 6: Organ Insights - LLM generates organ-by-organ findings from validated data → organ_insights.md
 * Phase 7: Report Generation - LLM with html-builder skill → interactive N1 Care Report (index.html)
 * Phase 8: Content Review - LLM compares structured_data.json vs index.html for gaps → content_review.json
 * Phase 9: HTML Regeneration - If gaps found, LLM regenerates HTML with feedback
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

import { LLMClientPort } from '../ports/llm-client.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import { LegacyPaths, OrganModel } from '../../common/storage-paths.js';
import { readFileWithEncoding } from '../../../vendor/gemini-cli/packages/core/src/utils/fileUtils.js';
import { PDFExtractionService } from '../../services/pdf-extraction.service.js';
import { AgenticMedicalAnalyst, type AnalystEvent } from '../../services/agentic-medical-analyst.service.js';
import { AgenticValidator, type ValidatorEvent } from '../../services/agentic-validator.service.js';
import { researchClaims, formatResearchAsMarkdown, type ResearchOutput, type ResearchEvent } from '../../services/research-agent.service.js';
import { REALM_CONFIG } from '../../config.js';
import { extractSourceExcerpts, extractLabSections } from '../../utils/source-excerpts.js';
import { deepMergeJsonPatch } from '../../utils/json-patch-merge.js';
import { transformOrganInsightsToBodyTwin } from '../../services/body-twin-transformer.service.js';
import { injectBodyTwinViewer } from '../../utils/inject-body-twin.js';
import type { RealmGenerationEvent } from '../../domain/types.js';
import type { ObservabilityPort } from '../ports/observability.port.js';
import { NoopObservabilityAdapter } from '../../adapters/langfuse/noop-observability.adapter.js';
// Note: Retry logic is handled at the adapter level (GeminiAdapter.sendMessageStream)
// No need to wrap LLM calls here - they are already protected by retryLLM in the adapter
import type { BillingContext } from '../../utils/billing.js';

export type { RealmGenerationEvent };

// ============================================================================
// Observability Constants
// ============================================================================

const SHORT_ID_LENGTH = 8;

const PipelinePhase = {
  DocumentExtraction: 'Phase 1 - Document Extraction',
  MedicalAnalysis: 'Phase 2 - Medical Analysis',
  Research: 'Phase 3 - Research',
  DataStructuring: 'Phase 4 - Data Structuring',
  Validation: 'Phase 5 - Validation',
  OrganInsights: 'Phase 6 - Organ Insights',
  HtmlGeneration: 'Phase 7 - HTML Generation',
  ContentReview: 'Phase 8 - Content Review',
  HtmlRegeneration: 'Phase 9 - HTML Regeneration',
} as const;

// ============================================================================
// Skill & Template Loaders
// ============================================================================

function loadSkill(skillName: string, fallback: string): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    skillName,
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract content after frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn(`[AgenticDoctor] Could not load ${skillName} SKILL.md`);
    return fallback;
  }
}

const loadMedicalAnalysisSkill = () => loadSkill(
  'medical-analysis',
  'You are a medical analyst. Analyze the patient data and write a comprehensive report.'
);

const loadHTMLBuilderSkill = () => loadSkill(
  'html-builder',
  'You are an HTML builder. Transform the analysis into a beautiful, interactive HTML page.'
);

const loadDataStructurerSkill = () => loadSkill(
  'data-structurer',
  'You are a data extraction specialist. Extract structured JSON from medical analysis for chart visualization.'
);

const loadContentReviewerSkill = () => loadSkill(
  'content-reviewer',
  'You are a QA agent. Compare structured_data.json against index.html to identify information loss.'
);

const loadOrganInsightsSkill = () => loadSkill(
  'organ-insights',
  'You are an organ-level clinical insight specialist. Analyze validated structured data and produce organ-by-organ findings in markdown.'
);

/**
 * Load the report HTML template (CSS + placeholders + snippet library).
 * The template is the single source of truth for visual design — the LLM
 * fills in {{SECTION:*}} placeholders instead of generating CSS.
 */
async function loadReportTemplate(): Promise<string> {
  const templatePath = path.join(
    process.cwd(),
    'src',
    'templates',
    'report_template.html'
  );

  try {
    return await fs.promises.readFile(templatePath, 'utf-8');
  } catch (error) {
    console.warn('[AgenticDoctor] Could not load report_template.html — LLM will generate CSS');
    return '';
  }
}

/**
 * Build template instructions for LLM prompts.
 * Shared between Phase 7 (initial generation) and Phase 9 (regeneration)
 * to ensure consistent behavior.
 */
function createTemplateInstructions(reportTemplate: string): string {
  if (!reportTemplate) {
    return '';
  }
  return `

---

### Report Template (START FROM THIS — DO NOT GENERATE CSS)
Work directly in this template. Replace each {{SECTION:*}} placeholder with generated HTML.
Use the snippet library at the bottom of the template for correct HTML structures.
- For JSON fields with data: replace the matching placeholder with rendered HTML
- For JSON fields without data: replace the placeholder with empty string
- Generate Plotly JavaScript for charts and place in {{CHARTS_INIT}}
- Replace {{REPORT_DATE}} with today's date
- Replace {{ADDITIONAL_CSS}} with empty string (or minimal overrides if needed)
<report_template>
${reportTemplate}
</report_template>
`;
}

// ============================================================================
// Helper: Strip LLM thinking text
// ============================================================================

function stripThinkingText(content: string, marker: string | RegExp): string {
  if (typeof marker === 'string') {
    const index = content.indexOf(marker);
    if (index > 0) {
      console.log(`[AgenticDoctor] Stripping ${index} chars of thinking text`);
      return content.slice(index);
    }
  } else {
    const match = content.match(marker);
    if (match && match.index && match.index > 0) {
      console.log(`[AgenticDoctor] Stripping ${match.index} chars of thinking text`);
      return content.slice(match.index);
    }
  }
  return content;
}

// ============================================================================
// Helper: Stream with retry for mid-stream failures
// ============================================================================

interface StreamWithRetryOptions {
  maxRetries?: number;
  operationName: string;
  onRetry?: (attempt: number, error: string) => void;
  billingContext?: BillingContext;
}

async function streamWithRetry(
  llmClient: LLMClientPort,
  prompt: string,
  sessionId: string,
  model: string,
  options: StreamWithRetryOptions
): Promise<string> {
  const maxRetries = options.maxRetries ?? 3;
  let attempt = 0;
  let content = '';

  while (attempt < maxRetries) {
    attempt++;
    content = ''; // Reset on each attempt

    try {
      const stream = await llmClient.sendMessageStream(
        prompt,
        `${sessionId}-${attempt}`,
        undefined,
        {
          model,
          billingContext: options.billingContext,
        }
      );

      for await (const chunk of stream) {
        content += chunk;
      }

      // Success - return content
      return content;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[AgenticDoctor] ${options.operationName} stream attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);

      if (attempt >= maxRetries) {
        throw error; // Re-throw on final attempt
      }

      // Notify caller of retry
      if (options.onRetry) {
        options.onRetry(attempt, errorMsg);
      }

      // Exponential backoff
      const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  return content;
}

function cleanupJson(content: string): string {
  content = content.trim();
  const jsonStartIndex = content.indexOf('{');
  if (jsonStartIndex > 0) {
    content = content.slice(jsonStartIndex);
  }
  if (content.startsWith('```json')) {
    content = content.slice(7);
  } else if (content.startsWith('```')) {
    content = content.slice(3);
  }
  if (content.endsWith('```')) {
    content = content.slice(0, -3);
  }
  return content.trim();
}

// ============================================================================
// Use Case Implementation
// ============================================================================

export class AgenticDoctorUseCase {
  private billingContext?: BillingContext;
  private readonly obs: ObservabilityPort;

  constructor(
    private readonly llmClient: LLMClientPort,
    private readonly storage: StoragePort,
    observability?: ObservabilityPort,
  ) {
    this.obs = observability ?? new NoopObservabilityAdapter();
  }

  /**
   * Set billing context for LiteLLM cost tracking.
   * Headers will be added to all LLM calls for billing attribution.
   */
  setBillingContext(context: BillingContext): void {
    this.billingContext = context;
  }

  async initialize(): Promise<void> {
    // No initialization needed for now
  }

  // ============================================================================
  // Session & Observability Helpers
  // ============================================================================

  private initSession(
    metadata: Record<string, unknown>,
    tags: string[] = ['easy-chr'],
  ): { sessionId: string; traceId: string; startSpan: (phase: string) => void; endSpan: (phase: string, meta?: Record<string, unknown>) => void } {
    const sessionId = uuidv4();
    const chrIdShort = this.billingContext?.chrId?.substring(0, SHORT_ID_LENGTH) ?? sessionId.substring(0, SHORT_ID_LENGTH);
    const dateStr = new Date().toISOString().slice(0, 10);

    let traceId = '';
    try {
      traceId = this.obs.createTrace({
        name: `chr-${this.billingContext?.userId ?? 'anon'}-easy-chr-${dateStr}-${chrIdShort}`,
        userId: this.billingContext?.userId,
        sessionId,
        metadata: {
          chrId: this.billingContext?.chrId,
          promptLength: metadata.promptLength ?? 0,
          ...metadata,
        },
        tags,
      });
    } catch { /* observability never blocks pipeline */ }

    const startSpan = (phase: string) => {
      try { this.obs.startSpan(phase, { name: phase, traceId }); } catch { /* non-fatal */ }
    };
    const endSpan = (phase: string, meta?: Record<string, unknown>) => {
      try { this.obs.endSpan(phase, meta); } catch { /* non-fatal */ }
    };

    return { sessionId, traceId, startSpan, endSpan };
  }

  // ============================================================================
  // Phase 1 Helpers: Document Extraction
  // ============================================================================

  /**
   * Run Vision OCR on PDF files and return the extracted content.
   * Yields log events during processing.
   */
  private async *extractPDFsViaOCR(
    pdfFiles: string[],
  ): AsyncGenerator<RealmGenerationEvent, string, unknown> {
    let ocrContent = '';

    yield { type: 'log', message: `Extracting ${pdfFiles.length} PDF(s) using Gemini Vision...` };

    const pdfExtractor = new PDFExtractionService(this.storage, this.billingContext);

    try {
      for await (const event of pdfExtractor.extractPDFs(pdfFiles)) {
        if (event.type === 'log' || event.type === 'progress') {
          yield { type: 'log', message: event.data.message || '' };
        } else if (event.type === 'page_complete') {
          const pageMessage = event.data.message
            || `Page ${event.data.pageNumber}/${event.data.totalPages} processed`;
          yield { type: 'log', message: `[${event.data.fileName}] ${pageMessage}` };
        } else if (event.type === 'error') {
          const errorDetails = event.data.error ? ` (${event.data.error})` : '';
          yield { type: 'log', message: `Warning: ${event.data.message}${errorDetails}` };
        }
      }

      if (await this.storage.exists(LegacyPaths.extracted)) {
        ocrContent = await this.storage.readFileAsString(LegacyPaths.extracted);
        console.log(`[AgenticDoctor] PDF extraction complete: ${ocrContent.length} chars`);
        yield { type: 'log', message: `PDF extraction complete (${pdfFiles.length} files)` };
      } else {
        yield { type: 'log', message: 'Warning: PDF extraction produced no output' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] PDF extraction failed:', errorMessage);
      yield { type: 'log', message: `PDF extraction failed: ${errorMessage}` };
    }

    return ocrContent;
  }

  /**
   * Extract text content from non-PDF files. Yields log events and returns
   * accumulated text with `## [fileName]` headers.
   */
  private async *extractNonPdfFiles(
    filePaths: string[],
  ): AsyncGenerator<RealmGenerationEvent, string, unknown> {
    let content = '';

    for (const filePath of filePaths) {
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

        content += `\n\n## [${fileName}]\n\n${textContent}`;
        yield { type: 'log', message: `Processed: ${fileName}` };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        yield { type: 'log', message: `Warning: Could not process ${path.basename(filePath)}: ${errorMessage}` };
      }
    }

    return content;
  }

  /**
   * Drain an async generator that yields RealmGenerationEvents and returns a string.
   * Re-yields all events and returns the final string value.
   * Using `yield*` with this method preserves correct types for both yields and the return.
   */
  private async *drainGenerator(
    gen: AsyncGenerator<RealmGenerationEvent, string, unknown>,
  ): AsyncGenerator<RealmGenerationEvent, string, unknown> {
    let r = await gen.next();
    while (!r.done) {
      yield r.value as RealmGenerationEvent;
      r = await gen.next();
    }
    return r.value;
  }

  /**
   * Classify file paths into PDFs and non-PDFs.
   */
  private classifyFiles(filePaths: string[]): { pdfFiles: string[]; otherFiles: string[] } {
    const pdfFiles: string[] = [];
    const otherFiles: string[] = [];

    for (const filePath of filePaths) {
      if (path.extname(filePath).toLowerCase() === '.pdf') {
        pdfFiles.push(filePath);
      } else {
        otherFiles.push(filePath);
      }
    }

    return { pdfFiles, otherFiles };
  }

  // ============================================================================
  // Public Entry Points
  // ============================================================================

  async *execute(
    prompt: string,
    uploadedFilePaths: string[],
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    await this.storage.ensureDir('');

    const { sessionId, traceId, startSpan, endSpan } = this.initSession(
      { fileCount: uploadedFilePaths.length, promptLength: prompt?.length ?? 0 },
    );

    console.log(`[AgenticDoctor] Session ${sessionId}: Processing ${uploadedFilePaths.length} files...`);
    console.log(`[AgenticDoctor] User prompt: ${prompt ? `(${prompt.length} chars)` : '(empty)'}`);

    // Phase 1: Document Extraction
    startSpan(PipelinePhase.DocumentExtraction);
    yield { type: 'step', name: 'Document Extraction', status: 'running' };
    yield { type: 'log', message: `Processing ${uploadedFilePaths.length} document(s)...` };

    const { pdfFiles, otherFiles } = this.classifyFiles(uploadedFilePaths);

    let allExtractedContent = '';

    // Process PDFs using Vision OCR
    if (pdfFiles.length > 0) {
      allExtractedContent = yield* this.drainGenerator(this.extractPDFsViaOCR(pdfFiles));
    }

    // Process non-PDF files
    if (otherFiles.length > 0) {
      allExtractedContent += yield* this.drainGenerator(this.extractNonPdfFiles(otherFiles));
    }

    // Save final extracted.md
    await this.storage.writeFile(LegacyPaths.extracted, allExtractedContent);

    endSpan(PipelinePhase.DocumentExtraction, { chars: allExtractedContent.length });
    yield { type: 'step', name: 'Document Extraction', status: 'completed' };

    if (!allExtractedContent || allExtractedContent.trim().length === 0) {
      yield { type: 'log', message: 'Error: No content could be extracted from documents.' };
      yield { type: 'step', name: 'Document Extraction', status: 'failed' };
      return;
    }

    console.log(`[AgenticDoctor] Total extracted content: ${allExtractedContent.length} chars`);
    yield { type: 'log', message: `Extraction complete. Output: ${LegacyPaths.extracted}` };

    yield* this.runPipelineFromPhase2(sessionId, traceId, prompt, allExtractedContent, startSpan, endSpan);
  }

  /**
   * Execute the pipeline starting from Phase 2, using pre-extracted content.
   * Skips Phase 1 (Document Extraction) entirely.
   * Used by the job-runner when markdown is pre-fetched from the N1 API.
   */
  async *executeWithExtractedContent(
    prompt: string,
    extractedContent: string,
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    await this.storage.ensureDir('');

    const { sessionId, traceId, startSpan, endSpan } = this.initSession(
      { preExtracted: true, contentLength: extractedContent.length, promptLength: prompt?.length ?? 0 },
      ['easy-chr', 'pre-extracted'],
    );

    console.log(`[AgenticDoctor] Session ${sessionId}: Processing pre-extracted content (${extractedContent.length} chars)...`);
    console.log(`[AgenticDoctor] User prompt: ${prompt ? `(${prompt.length} chars)` : '(empty)'}`);

    // Phase 1: skipped — save pre-extracted content as extracted.md
    startSpan(PipelinePhase.DocumentExtraction);
    yield { type: 'step', name: 'Document Extraction', status: 'running' };
    yield { type: 'log', message: 'Using pre-extracted markdown from N1 API (skipping OCR)...' };

    await this.storage.writeFile(LegacyPaths.extracted, extractedContent);

    endSpan(PipelinePhase.DocumentExtraction, { chars: extractedContent.length, preExtracted: true });
    yield { type: 'step', name: 'Document Extraction', status: 'completed' };

    if (!extractedContent || extractedContent.trim().length === 0) {
      yield { type: 'log', message: 'Error: Pre-extracted content is empty.' };
      yield { type: 'step', name: 'Document Extraction', status: 'failed' };
      return;
    }

    console.log(`[AgenticDoctor] Pre-extracted content: ${extractedContent.length} chars`);
    yield { type: 'log', message: `Pre-extracted content loaded: ${extractedContent.length} chars. Output: ${LegacyPaths.extracted}` };

    yield* this.runPipelineFromPhase2(sessionId, traceId, prompt, extractedContent, startSpan, endSpan);
  }

  /**
   * Execute the pipeline with a mix of pre-extracted markdown and additional
   * files that need Phase 1 (Vision OCR).
   *
   * Used when some records have pre-extracted markdown from the N1 API but
   * older records (pre-parser-router) only have PDFs.
   */
  async *executeWithMixedSources(
    prompt: string,
    preExtractedContent: string,
    additionalFilePaths: string[],
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    await this.storage.ensureDir('');

    const { sessionId, traceId, startSpan, endSpan } = this.initSession(
      { mixedSources: true, preExtractedLength: preExtractedContent.length, ocrFileCount: additionalFilePaths.length, promptLength: prompt?.length ?? 0 },
      ['easy-chr', 'mixed-sources'],
    );

    console.log(`[AgenticDoctor] Session ${sessionId}: Mixed sources - ${preExtractedContent.length} chars pre-extracted + ${additionalFilePaths.length} files for OCR`);
    console.log(`[AgenticDoctor] User prompt: ${prompt ? `(${prompt.length} chars)` : '(empty)'}`);

    // Phase 1: Run OCR on additional files, combine with pre-extracted content
    startSpan(PipelinePhase.DocumentExtraction);
    yield { type: 'step', name: 'Document Extraction', status: 'running' };
    yield { type: 'log', message: `Processing ${additionalFilePaths.length} file(s) via OCR + ${preExtractedContent.length} chars pre-extracted...` };

    let allExtractedContent = preExtractedContent;
    const { pdfFiles, otherFiles } = this.classifyFiles(additionalFilePaths);

    // Process PDFs using Vision OCR
    if (pdfFiles.length > 0) {
      const ocrContent = yield* this.drainGenerator(this.extractPDFsViaOCR(pdfFiles));
      if (ocrContent) {
        allExtractedContent += '\n\n---\n\n' + ocrContent;
      }
    }

    // Process non-PDF files
    if (otherFiles.length > 0) {
      allExtractedContent += yield* this.drainGenerator(this.extractNonPdfFiles(otherFiles));
    }

    // Save combined extracted.md
    await this.storage.writeFile(LegacyPaths.extracted, allExtractedContent);

    endSpan(PipelinePhase.DocumentExtraction, { chars: allExtractedContent.length, mixedSources: true });
    yield { type: 'step', name: 'Document Extraction', status: 'completed' };

    if (!allExtractedContent || allExtractedContent.trim().length === 0) {
      yield { type: 'log', message: 'Error: No content could be extracted from documents.' };
      yield { type: 'step', name: 'Document Extraction', status: 'failed' };
      return;
    }

    console.log(`[AgenticDoctor] Total combined content: ${allExtractedContent.length} chars`);
    yield { type: 'log', message: `Extraction complete (mixed sources). Output: ${LegacyPaths.extracted}` };

    yield* this.runPipelineFromPhase2(sessionId, traceId, prompt, allExtractedContent, startSpan, endSpan);
  }

  // ============================================================================
  // Phases 2-9
  // ============================================================================

  /**
   * Phases 2-9 of the pipeline. Shared by all entry points.
   */
  private async *runPipelineFromPhase2(
    sessionId: string,
    traceId: string,
    prompt: string,
    allExtractedContent: string,
    startSpan: (phase: string) => void,
    endSpan: (phase: string, meta?: Record<string, unknown>) => void,
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    // ========================================================================
    // Phase 2: Agentic Medical Analysis
    // Uses iterative tool-based exploration instead of single-pass analysis
    // The agent explores the data, forms hypotheses, seeks evidence, and builds
    // comprehensive analysis through multiple exploration cycles
    // ========================================================================
    startSpan(PipelinePhase.MedicalAnalysis);
    yield { type: 'step', name: 'Medical Analysis', status: 'running' };
    yield { type: 'log', message: 'Starting agentic medical analysis...' };

    let analysisContent = '';

    try {
      const agenticAnalyst = new AgenticMedicalAnalyst(this.billingContext, this.obs, traceId, PipelinePhase.MedicalAnalysis);

      yield { type: 'log', message: 'Agent is exploring the medical data...' };

      // Run the agentic analysis with tool use
      const analysisGenerator = agenticAnalyst.analyze(
        allExtractedContent,
        prompt, // Patient context/question
        35 // Max iterations for thorough exploration
      );

      // Consume the generator and capture the return value
      let result = await analysisGenerator.next();

      while (!result.done) {
        // When not done, value is always AnalystEvent (not the string return type)
        const event = result.value as AnalystEvent;

        switch (event.type) {
          case 'log':
            yield { type: 'log', message: event.data.message || '' };
            break;

          case 'tool_call':
            if (event.data.toolName && !event.data.toolResult) {
              yield {
                type: 'log',
                message: `[Tool] ${event.data.toolName}(${JSON.stringify(event.data.toolArgs || {}).substring(0, 100)})`
              };
            }
            break;

          case 'thinking':
            yield { type: 'log', message: `[Thinking] ${event.data.message?.substring(0, 200)}...` };
            break;

          case 'analysis_update':
            yield { type: 'log', message: `Analysis updated (${event.data.analysisContent?.length || 0} chars)` };
            // Track the latest analysis content
            if (event.data.analysisContent) {
              analysisContent = event.data.analysisContent;
            }
            break;

          case 'complete':
            yield { type: 'log', message: event.data.message || 'Analysis complete' };
            break;

          case 'error':
            yield { type: 'log', message: `Warning: ${event.data.message}` };
            break;
        }

        result = await analysisGenerator.next();
      }

      // Get the final analysis from the generator's return value
      if (result.done && typeof result.value === 'string' && result.value.length > 0) {
        analysisContent = result.value;
      }

      if (!analysisContent || analysisContent.trim().length === 0) {
        throw new Error('Agentic analysis produced no content');
      }

      await this.storage.writeFile(LegacyPaths.analysis, analysisContent);
      console.log(`[AgenticDoctor] Agentic analysis complete: ${analysisContent.length} chars`);

      yield { type: 'log', message: `Medical analysis complete (${analysisContent.length} chars)` };
      endSpan(PipelinePhase.MedicalAnalysis, { chars: analysisContent.length });
      yield { type: 'step', name: 'Medical Analysis', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Agentic analysis failed:', errorMessage);
      endSpan(PipelinePhase.MedicalAnalysis, { error: errorMessage });
      yield { type: 'log', message: `Medical analysis failed: ${errorMessage}` };
      yield { type: 'step', name: 'Medical Analysis', status: 'failed' };
      yield { type: 'result', url: LegacyPaths.extracted };
      return;
    }

    // ========================================================================
    // Phase 3: Research
    // Validates medical claims with external sources using web search
    // ========================================================================
    startSpan(PipelinePhase.Research);
    yield { type: 'step', name: 'Research', status: 'running' };
    yield { type: 'log', message: 'Validating claims with external sources...' };

    let researchOutput: ResearchOutput = { researchedClaims: [], unsupportedClaims: [], additionalFindings: [] };
    let researchMarkdown = '';

    try {
      // Get the Gemini config from the LLM client
      const geminiConfig = await this.llmClient.getConfig(this.billingContext);

      if (geminiConfig) {
        const researchGenerator = researchClaims(
          geminiConfig,
          analysisContent,
          prompt
        );

        // Process research events - manually iterate to capture return value
        let result = await researchGenerator.next();
        while (!result.done) {
          // When not done, result.value is ResearchEvent
          const event = result.value as ResearchEvent;

          switch (event.type) {
            case 'claim_extracted':
              yield { type: 'log', message: event.data.message || '' };
              break;
            case 'searching':
              yield { type: 'log', message: `[Research] ${event.data.message}` };
              break;
            case 'claim_researched':
              const sourcesCount = event.data.result?.sources?.length || 0;
              yield { type: 'log', message: `[Research] Claim ${event.data.claimIndex}/${event.data.totalClaims}: ${sourcesCount > 0 ? `${sourcesCount} source(s) found` : 'No sources found'}` };
              break;
            case 'complete':
              yield { type: 'log', message: event.data.message || '' };
              break;
            case 'error':
              yield { type: 'log', message: `[Research] Warning: ${event.data.message}` };
              break;
          }

          result = await researchGenerator.next();
        }

        // When done, result.value is ResearchOutput
        researchOutput = result.value as ResearchOutput;
        researchMarkdown = formatResearchAsMarkdown(researchOutput);

        // Save research output
        await this.storage.writeFile(LegacyPaths.research, JSON.stringify(researchOutput, null, 2));
        console.log(`[AgenticDoctor] Research complete: ${researchOutput.researchedClaims.length} claims verified`);

        yield { type: 'log', message: `Research complete: ${researchOutput.researchedClaims.length} claims verified, ${researchOutput.unsupportedClaims.length} unsupported` };
        endSpan(PipelinePhase.Research, { claimsVerified: researchOutput.researchedClaims.length });
        yield { type: 'step', name: 'Research', status: 'completed' };
      } else {
        console.warn('[AgenticDoctor] Gemini config not available, skipping research phase');
        endSpan(PipelinePhase.Research, { skipped: true });
        yield { type: 'log', message: 'Research skipped (Gemini config not available)' };
        yield { type: 'step', name: 'Research', status: 'completed' };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Research failed:', errorMessage);
      endSpan(PipelinePhase.Research, { error: errorMessage });
      yield { type: 'log', message: `Research failed: ${errorMessage}. Continuing without external validation.` };
      yield { type: 'step', name: 'Research', status: 'failed' };
      // Continue anyway - research is enhancement, not critical
    }

    // ========================================================================
    // Phase 4: Data Structuring (SOURCE OF TRUTH)
    // Extracts chart-ready JSON from analysis data
    // This becomes the source of truth for both Validation and HTML Builder
    // ========================================================================
    startSpan(PipelinePhase.DataStructuring);
    yield { type: 'step', name: 'Data Structuring', status: 'running' };
    yield { type: 'log', message: 'Extracting structured data for visualizations...' };

    let structuredDataContent = '';

    try {
      const dataStructurerSkill = loadDataStructurerSkill();

      const labSections = extractLabSections(allExtractedContent, 50_000);

      const structurePrompt = `${dataStructurerSkill}

---

${prompt ? `#### Patient's Question/Context\n${prompt}\n\n` : ''}### Priority 1: Rich Medical Analysis (PRIMARY source - includes cross-system connections)
<analysis>
${analysisContent}
</analysis>

### Priority 2: Research Findings (for citations and verified claims)
<research>
${researchMarkdown}
</research>

### Priority 3: Source Lab Data (for exact values, units, and reference ranges)
When the analysis omits units or reference ranges, use this raw lab data as the ground truth.
<source_lab_data>
${labSections}
</source_lab_data>`;
      // NOTE: full allExtractedContent intentionally EXCLUDED (991KB+ causes timeouts)
      // Instead, extractLabSections() provides a ~50KB subset of lab-data-dense sections

      // Log payload size for debugging network issues
      console.log(`[AgenticDoctor] Data structuring prompt payload: ${Math.round(structurePrompt.length / 1024)}KB`);

      const dsGenId = `gen-data-structuring-${sessionId}`;
      const dsStartTime = Date.now();
      try { this.obs.startGeneration(dsGenId, { name: 'data-structuring', traceId, parentSpanId: PipelinePhase.DataStructuring, model: REALM_CONFIG.models.doctor }); } catch { /* non-fatal */ }

      structuredDataContent = await streamWithRetry(
        this.llmClient,
        structurePrompt,
        `${sessionId}-structure`,
        REALM_CONFIG.models.doctor,
        {
          operationName: 'DataStructuring',
          maxRetries: 3,
          billingContext: this.billingContext,
        }
      );

      try { this.obs.endGeneration(dsGenId, { outputCharCount: structuredDataContent.length, latencyMs: Date.now() - dsStartTime }); } catch { /* non-fatal */ }

      if (structuredDataContent.trim().length === 0) {
        throw new Error('LLM returned empty structured data');
      }

      // Clean up the JSON
      structuredDataContent = structuredDataContent.trim();

      // Strip any text before the opening brace
      const jsonStartIndex = structuredDataContent.indexOf('{');
      if (jsonStartIndex > 0) {
        console.log(`[AgenticDoctor] Stripping ${jsonStartIndex} chars before JSON`);
        structuredDataContent = structuredDataContent.slice(jsonStartIndex);
      }

      // Strip any markdown code blocks
      if (structuredDataContent.startsWith('```json')) {
        structuredDataContent = structuredDataContent.slice(7);
      } else if (structuredDataContent.startsWith('```')) {
        structuredDataContent = structuredDataContent.slice(3);
      }
      if (structuredDataContent.endsWith('```')) {
        structuredDataContent = structuredDataContent.slice(0, -3);
      }
      structuredDataContent = structuredDataContent.trim();

      // Validate JSON
      try {
        JSON.parse(structuredDataContent);
        console.log(`[AgenticDoctor] Structured data: ${structuredDataContent.length} chars (valid JSON)`);
      } catch (jsonError) {
        console.warn('[AgenticDoctor] Structured data is not valid JSON, attempting repair...');
        // Try to find the last complete object
        const lastBrace = structuredDataContent.lastIndexOf('}');
        if (lastBrace > 0) {
          structuredDataContent = structuredDataContent.slice(0, lastBrace + 1);
          try {
            JSON.parse(structuredDataContent);
            console.log('[AgenticDoctor] JSON repaired successfully');
          } catch {
            console.warn('[AgenticDoctor] JSON repair failed, using empty structure');
            structuredDataContent = '{}';
          }
        }
      }

      await this.storage.writeFile(LegacyPaths.structuredData, structuredDataContent);

      yield { type: 'log', message: 'Data structuring complete.' };
      endSpan(PipelinePhase.DataStructuring, { chars: structuredDataContent.length });
      yield { type: 'step', name: 'Data Structuring', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Data structuring failed:', errorMessage);
      endSpan(PipelinePhase.DataStructuring, { error: errorMessage });
      yield { type: 'log', message: `Data structuring failed: ${errorMessage}. Cannot proceed without structured data.` };
      yield { type: 'step', name: 'Data Structuring', status: 'failed' };
      yield { type: 'error', content: `Data structuring failed: ${errorMessage}. The analysis cannot be visualized without structured data.` };
      return;
    }

    // Validate structured data is not empty - abort if empty
    try {
      const parsedData = JSON.parse(structuredDataContent);
      const keys = Object.keys(parsedData);
      if (keys.length === 0) {
        console.error('[AgenticDoctor] Structured data is empty object');
        yield { type: 'log', message: 'Data structuring produced empty result. Cannot proceed.' };
        yield { type: 'step', name: 'Data Structuring', status: 'failed' };
        yield { type: 'error', content: 'Data structuring failed to extract any data from the analysis. Please try again.' };
        return;
      }
      console.log(`[AgenticDoctor] Structured data has ${keys.length} top-level fields: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`);
    } catch {
      // JSON parse already validated above, this is just a safety check
    }

    // ========================================================================
    // Phase 5: Agentic Validation with Feedback Loop
    // Uses AgenticValidator with tool-based access for bidirectional validation
    // Can compare source date ranges vs JSON timeline to catch missing data
    // Maximum 1 correction cycle to avoid infinite loops
    // ========================================================================
    startSpan(PipelinePhase.Validation);
    yield { type: 'step', name: 'Validation', status: 'running' };
    yield { type: 'log', message: 'Starting agentic validation (tool-based)...' };

    const MAX_CORRECTION_CYCLES = 3;
    let correctionCycle = 0;
    let validationPassed = false;
    let validationContent = '';
    let allPreviouslyRaisedIssues: Array<{ category: string; severity: string; description: string }> = [];
    // Track ALL issues across ALL cycles with resolution status
    const allCycleIssues: Array<{ category: string; severity: string; description: string; cycle: number; corrected: boolean }> = [];

    while (correctionCycle <= MAX_CORRECTION_CYCLES && !validationPassed) {
      try {
        // Use AgenticValidator for tool-based validation
        const validator = new AgenticValidator(this.billingContext, this.obs, traceId, PipelinePhase.Validation);
        const validationGenerator = validator.validate(
          allExtractedContent,
          structuredDataContent,
          prompt,
          15, // max iterations
          allPreviouslyRaisedIssues
        );

        const validationIssues: Array<{
          category: string;
          severity: string;
          description: string;
        }> = [];
        let validationStatus = 'pass';
        let validationSummary = '';

        // Stream validation events and capture return value
        let iterResult = await validationGenerator.next();
        while (!iterResult.done) {
          const event = iterResult.value as ValidatorEvent;
          switch (event.type) {
            case 'log':
              yield { type: 'log', message: `[Validator] ${event.data.message}` };
              break;
            case 'tool_call':
              if (event.data.toolName) {
                console.log(`[AgenticDoctor] Validator tool: ${event.data.toolName}`);
              }
              break;
            case 'issue_found':
              if (event.data.issue) {
                validationIssues.push(event.data.issue);
                yield { type: 'log', message: `[Validator] Issue: [${event.data.issue.severity}] ${event.data.issue.description}` };
              }
              break;
            case 'complete':
              yield { type: 'log', message: `[Validator] ${event.data.message}` };
              break;
            case 'error':
              console.error(`[AgenticDoctor] Validator error: ${event.data.message}`);
              break;
          }
          iterResult = await validationGenerator.next();
        }

        // Get final result from generator return value
        const finalResult = iterResult.value as { status: string; issues: Array<{ category: string; severity: string; description: string }>; summary: string } | undefined;
        if (finalResult) {
          validationStatus = finalResult.status;
          validationSummary = finalResult.summary;
          validationIssues.push(...finalResult.issues.filter(i =>
            !validationIssues.some(existing => existing.description === i.description)
          ));
        }

        // Accumulate issues for next cycle (so validator skips previously raised issues)
        allPreviouslyRaisedIssues = [...allPreviouslyRaisedIssues, ...validationIssues];

        // Track issues from this cycle
        const cycleIssues = validationIssues.map(i => ({
          ...i, cycle: correctionCycle + 1, corrected: false,
        }));
        allCycleIssues.push(...cycleIssues);

        const actionableIssues = validationIssues.filter(i => i.severity === 'critical' || i.severity === 'warning');
        console.log(`[AgenticDoctor] Agentic validation cycle ${correctionCycle + 1}: ${validationIssues.length} issues (${actionableIssues.length} actionable)`);

        // Check if we need correction
        const needsRevision = validationStatus === 'needs_revision' || actionableIssues.length > 0;

        if (needsRevision) {
          yield { type: 'log', message: `Validation found ${actionableIssues.length} actionable issues that need correction.` };

          if (correctionCycle < MAX_CORRECTION_CYCLES) {
            yield { type: 'log', message: 'Sending corrections back to data structurer...' };

            // Build correction prompt with specific issues
            const issueList = actionableIssues.map(i => `- ${i.description}`).join('\n');

            const dataStructurerSkill = loadDataStructurerSkill();
            const sourceExcerpts = extractSourceExcerpts(allExtractedContent, actionableIssues);
            const correctionPrompt = `${dataStructurerSkill}

---

## CORRECTION TASK

The validator verified these issues against the raw source documents.
When the validator's findings conflict with the analyst's interpretation, the SOURCE DOCUMENT EXCERPTS are the ground truth.

${issueList}

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Source Document Excerpts (GROUND TRUTH — relevant sections for the issues found)
<source_excerpts>
${sourceExcerpts}
</source_excerpts>

### Medical Analysis (Analyst interpretation — may contain errors the validator caught)
<analysis>
${analysisContent}
</analysis>

### Previous Structured Data (Has Issues)
<previous_structured_data>
${structuredDataContent}
</previous_structured_data>

### Validation Issues (MUST FIX ALL — verified against source documents)
${actionableIssues.map(i => `- [${i.category}] ${i.description}`).join('\n')}

Output ONLY a JSON PATCH containing the fields that need to change.
- For fields that need updating: include the corrected value
- For arrays that need new items added: include only the new items to append
- For arrays that need full replacement: include the full array with {"_action": "replace"} as first element
- Do NOT include unchanged fields — only include what needs to change
- Output must be valid JSON starting with \`{\`

Example: To fix a unit in criticalFindings and add a missing medication:
\`\`\`json
{
  "criticalFindings": [{"_action": "replace"}, {"marker": "MarkerX", "value": 150, "unit": "mg/dL", "refRange": "70-100", "status": "high"}],
  "qualitativeData": {
    "medications": [{"name": "NewMed", "status": "current"}]
  }
}
\`\`\`

Output the JSON PATCH now (starting with \`{\`):`;

            let correctedContent = '';
            const correctionStream = await this.llmClient.sendMessageStream(
              correctionPrompt,
              `${sessionId}-correction-${correctionCycle}`,
              undefined,
              {
                model: REALM_CONFIG.models.doctor,
                billingContext: this.billingContext,
              }
            );

            for await (const chunk of correctionStream) {
              correctedContent += chunk;
            }

            if (correctedContent.trim().length > 0) {
              correctedContent = cleanupJson(correctedContent);

              try {
                const patch = JSON.parse(correctedContent);
                const original = JSON.parse(structuredDataContent);
                const merged = deepMergeJsonPatch(original, patch);
                structuredDataContent = JSON.stringify(merged, null, 2);
                await this.storage.writeFile(LegacyPaths.structuredData, structuredDataContent);
                console.log(`[AgenticDoctor] Surgical patch applied (${Object.keys(patch).length} fields). Result: ${structuredDataContent.length} chars`);
                yield { type: 'log', message: `Surgical correction applied (${Object.keys(patch).length} fields patched). Re-validating...` };
                // Mark this cycle's issues as corrected
                for (const ci of allCycleIssues) {
                  if (ci.cycle === correctionCycle + 1 && !ci.corrected) ci.corrected = true;
                }
              } catch {
                console.warn('[AgenticDoctor] Correction patch invalid JSON, keeping original.');
                yield { type: 'log', message: 'Correction produced invalid JSON, keeping original.' };
                validationPassed = true;
              }
            } else {
              yield { type: 'log', message: 'Correction returned empty, keeping original.' };
              validationPassed = true;
            }

            correctionCycle++;
          } else {
            yield { type: 'log', message: 'Max correction cycles reached. Proceeding with current data.' };
            validationPassed = true;
          }
        } else {
          yield { type: 'log', message: `Validation ${validationStatus === 'pass' ? 'passed' : 'passed with warnings'}.` };
          validationPassed = true;
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[AgenticDoctor] Agentic validation failed after all retries:', errorMessage);
        yield { type: 'log', message: `Validation error: ${errorMessage}` };

        // No fallback - the AgenticValidator already has retry logic via retryLLM.
        // If we reach here, all retries have been exhausted.
        // Mark validation as failed but continue with the pipeline.
        validationContent = `# Validation Report

## Status: FAILED

Validation could not be completed after all retry attempts.

**Error:** ${errorMessage}

**Note:** The structured data was not validated. Review the structured_data.json manually before relying on the generated HTML.

---

## Validation Method

AgenticValidator with tool-based exploration was attempted but failed.
All ${REALM_CONFIG.retry.llm.maxRetries} retries were exhausted.
`;
        await this.storage.writeFile(LegacyPaths.validation, validationContent);
        yield { type: 'log', message: 'Validation failed. Proceeding with unvalidated data.' };
        validationPassed = true; // Continue with pipeline despite validation failure
      }
    }

    // Write final validation report with FULL history across all cycles
    if (allCycleIssues.length > 0 || validationContent === '') {
      const correctedIssues = allCycleIssues.filter(i => i.corrected);
      const uncorrectedIssues = allCycleIssues.filter(i => !i.corrected);
      const reportStatus = uncorrectedIssues.some(i => i.severity === 'critical') ? 'NEEDS_REVISION' :
        uncorrectedIssues.length === 0 ? 'PASS' : 'PASS_WITH_WARNINGS';

      validationContent = `# Validation Report (Agentic)

**Status:** ${reportStatus}
**Correction Cycles:** ${correctionCycle}/${MAX_CORRECTION_CYCLES}
**Total Issues Found:** ${allCycleIssues.length} (${correctedIssues.length} corrected, ${uncorrectedIssues.length} remaining)

---

${correctedIssues.length > 0 ? `## Corrected Issues (${correctedIssues.length})\n\n${correctedIssues.map((issue, i) =>
  `### ${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category} *(Cycle ${issue.cycle} — Corrected)*\n${issue.description}`
).join('\n\n')}\n\n---\n` : ''}
${uncorrectedIssues.length > 0 ? `## Remaining Issues (${uncorrectedIssues.length})\n\n${uncorrectedIssues.map((issue, i) =>
  `### ${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category} *(Cycle ${issue.cycle})*\n${issue.description}`
).join('\n\n')}\n\n---\n` : ''}
${allCycleIssues.length === 0 ? '## Issues\n\nNo issues found.\n\n---\n' : ''}
## Validation Method

This validation was performed using the AgenticValidator with tool-based exploration:
- Source data explored via tools (list_documents, search_data, get_date_range)
- JSON timeline compared against source date range
- Bidirectional completeness check performed
`;
      await this.storage.writeFile(LegacyPaths.validation, validationContent);
    }

    endSpan(PipelinePhase.Validation, { correctionCycles: correctionCycle });
    yield { type: 'step', name: 'Validation', status: 'completed' };

    // ========================================================================
    // Phase 6: Organ Insights
    // Generates organ-by-organ clinical findings from validated structured data
    // Non-critical enrichment - pipeline continues if this fails
    // ========================================================================
    startSpan(PipelinePhase.OrganInsights);
    yield { type: 'step', name: 'Organ Insights', status: 'running' };
    yield { type: 'log', message: 'Generating organ-by-organ insights...' };

    let organInsightsContent = '';

    try {
      const organInsightsSkill = loadOrganInsightsSkill();

      const organInsightsPrompt = `${organInsightsSkill}

---

### Structured Data (Validated Source of Truth)
<structured_data>
${structuredDataContent}
</structured_data>

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}`;

      console.log(`[AgenticDoctor] Organ insights prompt payload: ${Math.round(organInsightsPrompt.length / 1024)}KB`);

      const oiGenId = `gen-organ-insights-${sessionId}`;
      const oiStartTime = Date.now();
      try { this.obs.startGeneration(oiGenId, { name: 'organ-insights', traceId, parentSpanId: PipelinePhase.OrganInsights, model: REALM_CONFIG.models.doctor }); } catch { /* non-fatal */ }

      organInsightsContent = await streamWithRetry(
        this.llmClient,
        organInsightsPrompt,
        `${sessionId}-organ-insights`,
        REALM_CONFIG.models.doctor,
        {
          operationName: 'OrganInsights',
          maxRetries: 3,
        }
      );

      try { this.obs.endGeneration(oiGenId, { outputCharCount: organInsightsContent.length, latencyMs: Date.now() - oiStartTime }); } catch { /* non-fatal */ }

      if (organInsightsContent.trim().length === 0) {
        throw new Error('LLM returned empty organ insights');
      }

      // Strip any thinking text before the markdown header
      organInsightsContent = stripThinkingText(organInsightsContent, '# Organ');

      await this.storage.writeFile(LegacyPaths.organInsights, organInsightsContent);
      console.log(`[AgenticDoctor] Organ insights complete: ${organInsightsContent.length} chars`);

      // Persist pre-computed body-twin.json for the 3D body viewer
      try {
        const bodyTwinData = transformOrganInsightsToBodyTwin(organInsightsContent);
        const bodyTwinJson = JSON.stringify(bodyTwinData, null, 2);
        await this.storage.writeFile(LegacyPaths.bodyTwin, bodyTwinJson, 'application/json');
        console.log(`[AgenticDoctor] Body twin data persisted: ${bodyTwinData.organs.length} organs, ${bodyTwinData.systems.length} systems`);
      } catch (btError) {
        const btMsg = btError instanceof Error ? btError.message : String(btError);
        console.warn(`[AgenticDoctor] Body twin transform failed (non-critical): ${btMsg}`);
      }

      yield { type: 'log', message: `Organ insights complete (${organInsightsContent.length} chars).` };
      endSpan(PipelinePhase.OrganInsights, { chars: organInsightsContent.length });
      yield { type: 'step', name: 'Organ Insights', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Organ insights failed:', errorMessage);
      endSpan(PipelinePhase.OrganInsights, { error: errorMessage });
      yield { type: 'log', message: `Organ insights failed: ${errorMessage}. Continuing without organ insights.` };
      yield { type: 'step', name: 'Organ Insights', status: 'failed' };
      // Non-critical — continue pipeline without organ insights
    }

    // ========================================================================
    // Phase 7: HTML Generation
    // Uses sendMessageStream with html-builder skill
    // DATA-DRIVEN: structured_data.json is the ONLY source - JSON drives structure
    // ========================================================================
    startSpan(PipelinePhase.HtmlGeneration);
    yield { type: 'step', name: 'Report Generation', status: 'running' };
    yield { type: 'log', message: 'Building your N1 Care Report...' };

    const realmId = sessionId;
    const realmPath = LegacyPaths.realm(realmId);

    // Ensure realm directory exists
    await this.storage.ensureDir(LegacyPaths.realmDir(realmId));

    try {
      const htmlSkill = loadHTMLBuilderSkill();
      const reportTemplate = await loadReportTemplate();
      const templateInstructions = createTemplateInstructions(reportTemplate);

      const htmlPrompt = `${htmlSkill}
${templateInstructions}
---

### Structured Data (SOURCE OF TRUTH)
This JSON contains ALL data for rendering. Iterate through each field and render appropriate sections.
Only render sections for fields that have data. Do not invent sections not in this JSON.
<structured_data>
${structuredDataContent}
</structured_data>
${organInsightsContent ? `
### Organ-by-Organ Insights (ENRICHMENT — use to enhance organ/system sections)
Use these insights to add clinical depth to relevant sections (systemsHealth, diagnoses, connections).
Render an "Organ Health Details" section with collapsible cards for each organ listed below.
Do NOT create sections for organs not listed here.
<organ_insights>
${organInsightsContent}
</organ_insights>` : ''}`;

      // Log payload size for debugging network issues
      const payloadSizeKB = Math.round(htmlPrompt.length / 1024);
      console.log(`[AgenticDoctor] HTML prompt payload: ${payloadSizeKB}KB (${htmlPrompt.length} chars)`);
      yield { type: 'log', message: `Generating interactive HTML experience (${payloadSizeKB}KB payload)...` };

      const htmlGenId = `gen-html-generation-${sessionId}`;
      const htmlStartTime = Date.now();
      try { this.obs.startGeneration(htmlGenId, { name: 'html-generation', traceId, parentSpanId: PipelinePhase.HtmlGeneration, model: REALM_CONFIG.models.html }); } catch { /* non-fatal */ }

      let htmlContent = await streamWithRetry(
        this.llmClient,
        htmlPrompt,
        `${sessionId}-html`,
        REALM_CONFIG.models.html,
        {
          operationName: 'HTMLGeneration',
          maxRetries: 3,
          billingContext: this.billingContext,
        }
      );

      try { this.obs.endGeneration(htmlGenId, { outputCharCount: htmlContent.length, latencyMs: Date.now() - htmlStartTime }); } catch { /* non-fatal */ }

      if (htmlContent.trim().length === 0) {
        throw new Error('LLM returned empty HTML');
      }

      // Clean up the HTML
      htmlContent = htmlContent.trim();

      // Strip any thinking text before <!DOCTYPE
      // Use lastIndexOf: the LLM sometimes mentions <!DOCTYPE in its thinking,
      // so the real one is the last occurrence.
      const doctypeIndex = htmlContent.lastIndexOf('<!DOCTYPE');
      if (doctypeIndex > 0) {
        console.log(`[AgenticDoctor] Stripping ${doctypeIndex} chars of thinking text from HTML`);
        htmlContent = htmlContent.slice(doctypeIndex);
      }

      // Handle markdown code blocks if present
      if (htmlContent.startsWith('```html')) {
        htmlContent = htmlContent.slice(7);
      } else if (htmlContent.startsWith('```')) {
        htmlContent = htmlContent.slice(3);
      }
      if (htmlContent.endsWith('```')) {
        htmlContent = htmlContent.slice(0, -3);
      }
      htmlContent = htmlContent.trim();

      // Write HTML to file
      await this.storage.writeFile(realmPath, htmlContent, 'text/html');
      console.log(`[AgenticDoctor] HTML report: ${htmlContent.length} chars`);

      yield { type: 'log', message: 'Initial HTML generation complete.' };
      endSpan(PipelinePhase.HtmlGeneration, { chars: htmlContent.length });
      yield { type: 'step', name: 'Report Generation', status: 'completed' };

      // ========================================================================
      // Phase 7: Content Review
      // Compares structured_data.json against index.html to identify information loss
      // ========================================================================
      startSpan(PipelinePhase.ContentReview);
      yield { type: 'step', name: 'Content Review', status: 'running' };
      yield { type: 'log', message: 'Reviewing HTML for completeness...' };

      let contentReviewResult: {
        user_question_addressed?: {
          passed: boolean;
          user_question: string;
          question_answered: boolean;
          answer_prominent: boolean;
          findings_connected: boolean;
          narrative_framed: boolean;
          issues: Array<{
            type: string;
            description: string;
            fix_instruction: string;
          }>;
        };
        detail_fidelity?: {
          passed: boolean;
          issues: Array<{
            type: string;
            severity: string;
            source_content: string;
            html_found: string;
            fix_instruction: string;
          }>;
        };
        content_completeness?: {
          passed: boolean;
          present_categories: string[];
          missing_categories: Array<{
            category: string;
            source_had: string;
            importance: string;
            fix_instruction: string;
          }>;
        };
        visual_design?: {
          score: string;
          strengths: string[];
          weaknesses: string[];
          fix_instructions: string[];
        };
        overall: {
          passed: boolean;
          summary: string;
          action: string;
          feedback_for_regeneration?: string;
        };
      } = { overall: { passed: true, summary: '', action: 'pass' } };

      try {
        const contentReviewerSkill = loadContentReviewerSkill();

        const reviewPrompt = `${contentReviewerSkill}

---

### User's Original Question (THE PRIMARY PURPOSE)
<user_question>
${prompt || '(No specific question provided - general health analysis requested)'}
</user_question>

### Source of Truth (structured_data.json)
<structured_data>
${structuredDataContent}
</structured_data>

### Output to Validate (index.html)
<html_content>
${htmlContent}
</html_content>`;

        console.log(`[AgenticDoctor] Content review prompt payload: ${Math.round(reviewPrompt.length / 1024)}KB`);

        const crGenId = `gen-content-review-${sessionId}`;
        const crStartTime = Date.now();
        try { this.obs.startGeneration(crGenId, { name: 'content-review', traceId, parentSpanId: PipelinePhase.ContentReview, model: REALM_CONFIG.models.doctor }); } catch { /* non-fatal */ }

        let reviewContent = '';
        const reviewStream = await this.llmClient.sendMessageStream(
          reviewPrompt,
          `${sessionId}-content-review`,
          undefined,
          {
            model: REALM_CONFIG.models.doctor,
            billingContext: this.billingContext,
          }
        );

        for await (const chunk of reviewStream) {
          reviewContent += chunk;
        }

        try { this.obs.endGeneration(crGenId, { outputCharCount: reviewContent.length, latencyMs: Date.now() - crStartTime }); } catch { /* non-fatal */ }

        if (reviewContent.trim().length === 0) {
          throw new Error('Content review returned empty');
        }

        // Clean up JSON
        reviewContent = reviewContent.trim();
        const jsonStartIndex = reviewContent.indexOf('{');
        if (jsonStartIndex > 0) {
          reviewContent = reviewContent.slice(jsonStartIndex);
        }
        if (reviewContent.startsWith('```json')) {
          reviewContent = reviewContent.slice(7);
        } else if (reviewContent.startsWith('```')) {
          reviewContent = reviewContent.slice(3);
        }
        if (reviewContent.endsWith('```')) {
          reviewContent = reviewContent.slice(0, -3);
        }
        reviewContent = reviewContent.trim();

        // Parse and save
        try {
          contentReviewResult = JSON.parse(reviewContent);
          await this.storage.writeFile(LegacyPaths.contentReview, JSON.stringify(contentReviewResult, null, 2));
          console.log(`[AgenticDoctor] Content review: passed=${contentReviewResult.overall.passed}, action=${contentReviewResult.overall.action}`);
        } catch (jsonError) {
          console.warn('[AgenticDoctor] Content review JSON parse failed, assuming pass');
          contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } };
        }

        if (contentReviewResult.overall.passed) {
          yield { type: 'log', message: 'Content review passed - all four dimensions acceptable.' };
        } else {
          yield { type: 'log', message: 'Content review found issues:' };

          // Dimension 0: User Question Addressed (MOST IMPORTANT)
          if (contentReviewResult.user_question_addressed && !contentReviewResult.user_question_addressed.passed) {
            yield { type: 'log', message: `[User Question] NOT ADDRESSED - ${contentReviewResult.user_question_addressed.issues.length} issue(s)` };
            if (!contentReviewResult.user_question_addressed.question_answered) {
              yield { type: 'log', message: '  - Question not directly answered' };
            }
            if (!contentReviewResult.user_question_addressed.answer_prominent) {
              yield { type: 'log', message: '  - Answer not prominent/visible' };
            }
          }

          // Dimension 1: Detail Fidelity
          if (contentReviewResult.detail_fidelity && !contentReviewResult.detail_fidelity.passed) {
            const highCount = contentReviewResult.detail_fidelity.issues.filter(i => i.severity === 'high').length;
            yield { type: 'log', message: `[Detail Fidelity] ${contentReviewResult.detail_fidelity.issues.length} issues (${highCount} high severity)` };
          }

          // Dimension 2: Content Completeness
          if (contentReviewResult.content_completeness && !contentReviewResult.content_completeness.passed) {
            const missing = contentReviewResult.content_completeness.missing_categories.map(c => c.category).join(', ');
            yield { type: 'log', message: `[Content Completeness] Missing: ${missing}` };
          }

          // Dimension 3: Visual Design
          if (contentReviewResult.visual_design) {
            yield { type: 'log', message: `[Visual Design] Score: ${contentReviewResult.visual_design.score}` };
          }

          if (contentReviewResult.overall.summary) {
            yield { type: 'log', message: `Summary: ${contentReviewResult.overall.summary}` };
          }
        }

        endSpan(PipelinePhase.ContentReview, { passed: contentReviewResult.overall.passed });
        yield { type: 'step', name: 'Content Review', status: 'completed' };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[AgenticDoctor] Content review failed:', errorMessage);
        endSpan(PipelinePhase.ContentReview, { error: errorMessage });
        yield { type: 'log', message: `Content review failed: ${errorMessage}. Proceeding with current HTML.` };
        yield { type: 'step', name: 'Content Review', status: 'failed' };
        contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } }; // Skip patching on error
      }

      // ========================================================================
      // Phase 8: HTML Regeneration (if needed)
      // If content review found issues, regenerate HTML with feedback
      // ========================================================================
      if (contentReviewResult.overall.action === 'regenerate_with_feedback' && contentReviewResult.overall.feedback_for_regeneration) {
        startSpan(PipelinePhase.HtmlRegeneration);
        yield { type: 'step', name: 'HTML Regeneration', status: 'running' };
        yield { type: 'log', message: 'Regenerating HTML with reviewer feedback...' };

        try {
          const htmlSkill = loadHTMLBuilderSkill();
          const reportTemplate = await loadReportTemplate();
          const templateInstructions = createTemplateInstructions(reportTemplate);

          // Build regeneration prompt with feedback
          const regenPrompt = `${htmlSkill}
${templateInstructions}
---

## REGENERATION TASK

Your previous HTML output had issues. You need to regenerate addressing ALL of the following:

### Reviewer Feedback (MUST ADDRESS)
<feedback>
${contentReviewResult.overall.feedback_for_regeneration}
</feedback>

### User Question Issues (MOST IMPORTANT - FIX FIRST)
<user_question_issues>
User Asked: ${contentReviewResult.user_question_addressed?.user_question || prompt || 'N/A'}
Question Answered: ${contentReviewResult.user_question_addressed?.question_answered || false}
Answer Prominent: ${contentReviewResult.user_question_addressed?.answer_prominent || false}
Findings Connected: ${contentReviewResult.user_question_addressed?.findings_connected || false}
Issues: ${JSON.stringify(contentReviewResult.user_question_addressed?.issues || [], null, 2)}
</user_question_issues>

### Detail Fidelity Issues
<detail_issues>
${JSON.stringify(contentReviewResult.detail_fidelity?.issues || [], null, 2)}
</detail_issues>

### Missing Content Categories
<missing_categories>
${JSON.stringify(contentReviewResult.content_completeness?.missing_categories || [], null, 2)}
</missing_categories>

### Visual Design Feedback
<design_feedback>
Score: ${contentReviewResult.visual_design?.score || 'unknown'}
Weaknesses: ${JSON.stringify(contentReviewResult.visual_design?.weaknesses || [], null, 2)}
Fix Instructions: ${JSON.stringify(contentReviewResult.visual_design?.fix_instructions || [], null, 2)}
</design_feedback>

### Source Data (use ALL details from here)

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Structured Data (SOURCE OF TRUTH - the JSON drives all HTML sections)
<structured_data>
${structuredDataContent}
</structured_data>
${organInsightsContent ? `
### Organ-by-Organ Insights (ENRICHMENT)
<organ_insights>
${organInsightsContent}
</organ_insights>` : ''}

## CRITICAL INSTRUCTIONS

1. Address EVERY issue in the feedback
2. Include ALL specific names, dosages, values, timings from the structured data
3. Do NOT genericize or summarize - use exact details from JSON
4. Make urgent/critical items visually prominent (callouts, warnings, colored boxes)
5. Preserve explanatory context - the WHY matters as much as the WHAT
6. Only render sections for fields that have data in the JSON

**Output the complete regenerated HTML now.**`;

          console.log(`[AgenticDoctor] Regeneration prompt payload: ${Math.round(regenPrompt.length / 1024)}KB`);

          const regenGenId = `gen-html-regeneration-${sessionId}`;
          const regenStartTime = Date.now();
          try { this.obs.startGeneration(regenGenId, { name: 'html-regeneration', traceId, parentSpanId: PipelinePhase.HtmlRegeneration, model: REALM_CONFIG.models.html }); } catch { /* non-fatal */ }

          let regenHtml = '';
          const regenStream = await this.llmClient.sendMessageStream(
            regenPrompt,
            `${sessionId}-html-regen`,
            undefined,
            {
              model: REALM_CONFIG.models.html,
              billingContext: this.billingContext,
            }
          );

          for await (const chunk of regenStream) {
            regenHtml += chunk;
          }

          try { this.obs.endGeneration(regenGenId, { outputCharCount: regenHtml.length, latencyMs: Date.now() - regenStartTime }); } catch { /* non-fatal */ }

          if (regenHtml.trim().length > 0) {
            // Clean up regenerated HTML
            regenHtml = regenHtml.trim();
            const regenDoctypeIndex = regenHtml.lastIndexOf('<!DOCTYPE');
            if (regenDoctypeIndex > 0) {
              regenHtml = regenHtml.slice(regenDoctypeIndex);
            }
            if (regenHtml.startsWith('```html')) {
              regenHtml = regenHtml.slice(7);
            } else if (regenHtml.startsWith('```')) {
              regenHtml = regenHtml.slice(3);
            }
            if (regenHtml.endsWith('```')) {
              regenHtml = regenHtml.slice(0, -3);
            }
            regenHtml = regenHtml.trim();

            // Validate it's valid HTML
            if (regenHtml.includes('<!DOCTYPE') && regenHtml.includes('</html>')) {
              htmlContent = regenHtml;
              await this.storage.writeFile(realmPath, htmlContent, 'text/html');
              console.log(`[AgenticDoctor] Regenerated HTML: ${htmlContent.length} chars`);
              yield { type: 'log', message: 'HTML regenerated with fixes.' };
            } else {
              yield { type: 'log', message: 'Regeneration produced invalid HTML, keeping original.' };
            }
          } else {
            yield { type: 'log', message: 'Regeneration returned empty, keeping original HTML.' };
          }

          endSpan(PipelinePhase.HtmlRegeneration);
          yield { type: 'step', name: 'HTML Regeneration', status: 'completed' };

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[AgenticDoctor] HTML regeneration failed:', errorMessage);
          endSpan(PipelinePhase.HtmlRegeneration, { error: errorMessage });
          yield { type: 'log', message: `HTML regeneration failed: ${errorMessage}. Using original HTML.` };
          yield { type: 'step', name: 'HTML Regeneration', status: 'failed' };
        }
      }

      // Inject 3D body twin viewer if organ insights are available
      if (organInsightsContent) {
        try {
          const bodyTwinData = transformOrganInsightsToBodyTwin(organInsightsContent);
          htmlContent = injectBodyTwinViewer(htmlContent, bodyTwinData);
          await this.storage.writeFile(realmPath, htmlContent, 'text/html');
          console.log(`[AgenticDoctor] Injected 3D body twin viewer`);
          yield { type: 'log', message: 'Injected 3D body twin viewer into HTML.' };

          // Copy 3D organ model to realm directory so it's served alongside the HTML
          try {
            const glbSource = OrganModel.localSourcePath();
            const glbBuffer = fs.readFileSync(glbSource);
            const glbDestPath = `realms/${realmId}/${OrganModel.FILENAME}`;
            await this.storage.writeFile(glbDestPath, glbBuffer, OrganModel.CONTENT_TYPE);
            console.log(`[AgenticDoctor] Copied 3D organ model to ${glbDestPath} (${(glbBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
          } catch (glbErr) {
            const glbMsg = glbErr instanceof Error ? glbErr.message : String(glbErr);
            console.warn(`[AgenticDoctor] GLB copy failed (non-critical): ${glbMsg}`);
          }
        } catch (btErr) {
          const msg = btErr instanceof Error ? btErr.message : String(btErr);
          console.warn(`[AgenticDoctor] Body twin injection failed (non-critical): ${msg}`);
        }
      }

      // Return the realm URL
      const realmUrl = `/realms/${realmId}/index.html`;

      console.log(`[AgenticDoctor] Pipeline complete. Realm: ${realmUrl}`);
      yield { type: 'log', message: `N1 Care Report ready: ${realmUrl}` };
      yield { type: 'result', url: realmUrl };

      // Score trace as success
      try { this.obs.scoreTrace(traceId, 'pipeline_success', 1, 'Pipeline completed successfully'); } catch { /* non-fatal */ }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] HTML generation failed:', errorMessage);
      endSpan(PipelinePhase.HtmlGeneration, { error: errorMessage });
      yield { type: 'log', message: `Report generation failed: ${errorMessage}` };
      yield { type: 'step', name: 'Report Generation', status: 'failed' };
      yield { type: 'error', content: `Report generation failed: ${errorMessage}` };

      // Score trace as failure
      try { this.obs.scoreTrace(traceId, 'pipeline_success', 0, errorMessage); } catch { /* non-fatal */ }
    }

    // Flush observability data — best-effort, never blocks
    try { this.obs.flush().catch(() => {}); } catch { /* non-fatal */ }
  }
}
