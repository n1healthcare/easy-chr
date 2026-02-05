/**
 * AgenticDoctorUseCase - Medical Document Analysis Pipeline
 *
 * 9-Phase Pipeline:
 * Phase 1: Document Extraction - PDFs via Vision OCR, text files directly → extracted.md
 * Phase 2: Medical Analysis - LLM with medical-analysis skill → analysis.md
 * Phase 3: Cross-System Analysis - LLM identifies connections between systems → cross_systems.md
 * Phase 4: Research - Web search to validate claims with external sources → research.json
 * Phase 5: Data Structuring - LLM extracts chart-ready JSON (SOURCE OF TRUTH) → structured_data.json
 * Phase 6: Validation - LLM validates structured_data.json completeness → validation.md (with correction loop)
 * Phase 7: Realm Generation - LLM with html-builder skill → interactive Health Realm (index.html)
 * Phase 8: Content Review - LLM compares structured_data.json vs index.html for gaps → content_review.json
 * Phase 9: HTML Regeneration - If gaps found, LLM regenerates HTML with feedback
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

import { LLMClientPort } from '../ports/llm-client.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import { LegacyPaths } from '../../common/storage-paths.js';
import { readFileWithEncoding } from '../../../vendor/gemini-cli/packages/core/src/utils/fileUtils.js';
import { PDFExtractionService } from '../../services/pdf-extraction.service.js';
import { AgenticMedicalAnalyst, type AnalystEvent } from '../../services/agentic-medical-analyst.service.js';
import { researchClaims, formatResearchAsMarkdown, type ResearchOutput, type ResearchEvent } from '../../services/research-agent.service.js';
import { REALM_CONFIG } from '../../config.js';
import type { RealmGenerationEvent } from '../../domain/types.js';
// Note: Retry logic is handled at the adapter level (GeminiAdapter.sendMessageStream)
// No need to wrap LLM calls here - they are already protected by retryLLM in the adapter
import type { BillingContext } from '../../utils/billing.js';

export type { RealmGenerationEvent };

// ============================================================================
// Skill Loaders
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

const loadCrossSystemSkill = () => loadSkill(
  'cross-system-analyst',
  'You are a systems medicine specialist. Identify connections between body systems and root cause hypotheses.'
);

const loadValidatorSkill = () => loadSkill(
  'validator',
  'You are a quality assurance specialist. Validate that the analysis is complete and accurate.'
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

  constructor(
    private readonly llmClient: LLMClientPort,
    private readonly storage: StoragePort
  ) {}

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

  async *execute(
    prompt: string,
    uploadedFilePaths: string[],
  ): AsyncGenerator<RealmGenerationEvent, void, unknown> {
    const sessionId = uuidv4();

    // Ensure storage directory exists
    await this.storage.ensureDir('');

    console.log(`[AgenticDoctor] Session ${sessionId}: Processing ${uploadedFilePaths.length} files...`);
    console.log(`[AgenticDoctor] User prompt: "${prompt ? prompt.substring(0, 100) : '(empty)'}"${prompt && prompt.length > 100 ? '...' : ''}`);

    // ========================================================================
    // Phase 1: Document Extraction
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

      const pdfExtractor = new PDFExtractionService(this.storage, this.billingContext);

      try {
        for await (const event of pdfExtractor.extractPDFs(pdfFiles)) {
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

        if (await this.storage.exists(LegacyPaths.extracted)) {
          allExtractedContent = await this.storage.readFileAsString(LegacyPaths.extracted);
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
    await this.storage.writeFile(LegacyPaths.extracted, allExtractedContent);

    yield { type: 'step', name: 'Document Extraction', status: 'completed' };

    if (!allExtractedContent || allExtractedContent.trim().length === 0) {
      yield { type: 'log', message: 'Error: No content could be extracted from documents.' };
      yield { type: 'step', name: 'Document Extraction', status: 'failed' };
      return;
    }

    console.log(`[AgenticDoctor] Total extracted content: ${allExtractedContent.length} chars`);
    yield { type: 'log', message: `Extraction complete. Output: ${LegacyPaths.extracted}` };

    // ========================================================================
    // Phase 2: Agentic Medical Analysis
    // Uses iterative tool-based exploration instead of single-pass analysis
    // The agent explores the data, forms hypotheses, seeks evidence, and builds
    // comprehensive analysis through multiple exploration cycles
    // ========================================================================
    yield { type: 'step', name: 'Medical Analysis', status: 'running' };
    yield { type: 'log', message: 'Starting agentic medical analysis...' };

    let analysisContent = '';

    try {
      const agenticAnalyst = new AgenticMedicalAnalyst(this.billingContext);

      yield { type: 'log', message: 'Agent is exploring the medical data...' };

      // Run the agentic analysis with tool use
      const analysisGenerator = agenticAnalyst.analyze(
        allExtractedContent,
        prompt, // Patient context/question
        25 // Max iterations for thorough exploration
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
      yield { type: 'step', name: 'Medical Analysis', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Agentic analysis failed:', errorMessage);
      yield { type: 'log', message: `Medical analysis failed: ${errorMessage}` };
      yield { type: 'step', name: 'Medical Analysis', status: 'failed' };
      yield { type: 'result', url: LegacyPaths.extracted };
      return;
    }

    // ========================================================================
    // Phase 3: Cross-System Analysis
    // Identifies connections between body systems
    // ========================================================================
    yield { type: 'step', name: 'Cross-System Analysis', status: 'running' };
    yield { type: 'log', message: 'Analyzing cross-system connections...' };

    let crossSystemsContent = '';

    try {
      const crossSystemSkill = loadCrossSystemSkill();

      const crossSystemPrompt = `${crossSystemSkill}

---

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data
<extracted_data>
${allExtractedContent}
</extracted_data>

### Initial Medical Analysis
<analysis>
${analysisContent}
</analysis>`;

      const crossSystemStream = await this.llmClient.sendMessageStream(
        crossSystemPrompt,
        `${sessionId}-crosssystem`,
        undefined,
        { model: REALM_CONFIG.models.doctor }
      );

      for await (const chunk of crossSystemStream) {
        crossSystemsContent += chunk;
      }

      if (crossSystemsContent.trim().length === 0) {
        throw new Error('LLM returned empty cross-system analysis');
      }

      // Strip thinking text
      crossSystemsContent = stripThinkingText(crossSystemsContent, /^#\s+.+$/m);

      await this.storage.writeFile(LegacyPaths.crossSystems, crossSystemsContent);
      console.log(`[AgenticDoctor] Cross-system analysis: ${crossSystemsContent.length} chars`);

      yield { type: 'log', message: 'Cross-system analysis complete.' };
      yield { type: 'step', name: 'Cross-System Analysis', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Cross-system analysis failed:', errorMessage);
      yield { type: 'log', message: `Cross-system analysis failed: ${errorMessage}. Continuing with basic analysis.` };
      yield { type: 'step', name: 'Cross-System Analysis', status: 'failed' };
      // Continue anyway - cross-system is enhancement, not critical
      crossSystemsContent = '(Cross-system analysis not available)';
    }

    // ========================================================================
    // Phase 4: Research
    // Validates medical claims with external sources using web search
    // ========================================================================
    yield { type: 'step', name: 'Research', status: 'running' };
    yield { type: 'log', message: 'Validating claims with external sources...' };

    let researchOutput: ResearchOutput = { researchedClaims: [], unsupportedClaims: [], additionalFindings: [] };
    let researchMarkdown = '';

    try {
      // Get the Gemini config from the LLM client
      const geminiConfig = this.llmClient.getConfig();

      if (geminiConfig) {
        const researchGenerator = researchClaims(
          geminiConfig,
          analysisContent,
          crossSystemsContent,
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
        yield { type: 'step', name: 'Research', status: 'completed' };
      } else {
        console.warn('[AgenticDoctor] Gemini config not available, skipping research phase');
        yield { type: 'log', message: 'Research skipped (Gemini config not available)' };
        yield { type: 'step', name: 'Research', status: 'completed' };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Research failed:', errorMessage);
      yield { type: 'log', message: `Research failed: ${errorMessage}. Continuing without external validation.` };
      yield { type: 'step', name: 'Research', status: 'failed' };
      // Continue anyway - research is enhancement, not critical
    }

    // ========================================================================
    // Phase 5: Data Structuring (SOURCE OF TRUTH)
    // Extracts chart-ready JSON from analysis data BEFORE synthesis
    // This becomes the source of truth for both Synthesis and HTML Builder
    // ========================================================================
    yield { type: 'step', name: 'Data Structuring', status: 'running' };
    yield { type: 'log', message: 'Extracting structured data for visualizations...' };

    let structuredDataContent = '';

    try {
      const dataStructurerSkill = loadDataStructurerSkill();

      const structurePrompt = `${dataStructurerSkill}

---

${prompt ? `#### Patient's Question/Context\n${prompt}\n\n` : ''}### Priority 1: Rich Medical Analysis (PRIMARY for diagnoses, timeline, prognosis, supplements)
<analysis>
${analysisContent}
</analysis>

### Priority 2: Cross-System Connections (for mechanism explanations)
<cross_systems>
${crossSystemsContent}
</cross_systems>

### Priority 3: Research Findings (for citations and verified claims)
<research>
${researchMarkdown}
</research>`;
      // NOTE: allExtractedContent intentionally EXCLUDED to keep payload manageable
      // The analysis already interprets the raw data, so including it is redundant
      // and causes 991KB+ payloads that timeout

      // Log payload size for debugging network issues
      console.log(`[AgenticDoctor] Data structuring prompt payload: ${Math.round(structurePrompt.length / 1024)}KB`);

      const structureStream = await this.llmClient.sendMessageStream(
        structurePrompt,
        `${sessionId}-structure`,
        undefined,
        { model: REALM_CONFIG.models.doctor }
      );

      for await (const chunk of structureStream) {
        structuredDataContent += chunk;
      }

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
      yield { type: 'step', name: 'Data Structuring', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Data structuring failed:', errorMessage);
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
    // Phase 6: Validation with Feedback Loop
    // Validates structured_data.json completeness against source data
    // Maximum 1 correction cycle to avoid infinite loops
    // ========================================================================
    yield { type: 'step', name: 'Validation', status: 'running' };
    yield { type: 'log', message: 'Validating structured data completeness...' };

    const MAX_CORRECTION_CYCLES = 1;
    let correctionCycle = 0;
    let validationPassed = false;

    while (correctionCycle <= MAX_CORRECTION_CYCLES && !validationPassed) {
      try {
        const validatorSkill = loadValidatorSkill();

        const validationPrompt = `${validatorSkill}

---

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth for raw values)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Medical Analysis (Source of Truth for clinical interpretation)
<analysis>
${analysisContent}
</analysis>

### Structured Data (To Validate)
<structured_data>
${structuredDataContent}
</structured_data>`;

        // Log payload size for debugging network issues
        console.log(`[AgenticDoctor] Validation prompt payload: ${Math.round(validationPrompt.length / 1024)}KB`);

        let validationContent = '';
        const validationStream = await this.llmClient.sendMessageStream(
          validationPrompt,
          `${sessionId}-validation-${correctionCycle}`,
          undefined,
          { model: REALM_CONFIG.models.doctor }
        );

        for await (const chunk of validationStream) {
          validationContent += chunk;
        }

        if (validationContent.trim().length === 0) {
          throw new Error('LLM returned empty validation');
        }

        // Strip thinking text
        validationContent = stripThinkingText(validationContent, /^#\s+.+$/m);

        await this.storage.writeFile(LegacyPaths.validation, validationContent);
        console.log(`[AgenticDoctor] Validation report (cycle ${correctionCycle}): ${validationContent.length} chars`);

        // Check if validation passed or needs revision
        const needsRevision = validationContent.toLowerCase().includes('needs revision');
        const hasCriticalErrors = (validationContent.match(/❌/g) || []).length > 0;

        if (needsRevision || hasCriticalErrors) {
          yield { type: 'log', message: `Validation found issues that need correction.` };

          // If we haven't exceeded correction cycles, attempt to fix
          if (correctionCycle < MAX_CORRECTION_CYCLES) {
            yield { type: 'log', message: 'Sending corrections back to data structurer...' };

            // Extract the "Required Corrections" section if present
            const correctionsMatch = validationContent.match(/## Required Corrections[\s\S]*?(?=##|$)/);
            const requiredCorrections = correctionsMatch ? correctionsMatch[0] : '';

            // Create correction prompt for data structurer
            const dataStructurerSkill = loadDataStructurerSkill();
            const correctionPrompt = `${dataStructurerSkill}

---

## CORRECTION TASK

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth for raw values)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Medical Analysis (Source of Truth for clinical interpretation)
<analysis>
${analysisContent}
</analysis>

### Previous Structured Data (Has Issues)
<previous_structured_data>
${structuredDataContent}
</previous_structured_data>

### Validation Report
<validation_report>
${validationContent}
</validation_report>

${requiredCorrections ? `### Required Corrections (MUST FIX)\n${requiredCorrections}` : ''}

Output the CORRECTED JSON now (starting with \`{\`):`;

            let correctedContent = '';
            const correctionStream = await this.llmClient.sendMessageStream(
              correctionPrompt,
              `${sessionId}-correction-${correctionCycle}`,
              undefined,
              { model: REALM_CONFIG.models.doctor }
            );

            for await (const chunk of correctionStream) {
              correctedContent += chunk;
            }

            if (correctedContent.trim().length > 0) {
              // Clean up JSON
              correctedContent = cleanupJson(correctedContent);

              // Validate JSON
              try {
                JSON.parse(correctedContent);
                // Update structuredDataContent with corrected version
                structuredDataContent = correctedContent;
                await this.storage.writeFile(LegacyPaths.structuredData, structuredDataContent);
                console.log(`[AgenticDoctor] Corrected structured data: ${structuredDataContent.length} chars`);
                yield { type: 'log', message: 'Structured data corrected. Re-validating...' };
              } catch {
                console.warn('[AgenticDoctor] Corrected JSON invalid, keeping original.');
                yield { type: 'log', message: 'Correction produced invalid JSON, keeping original.' };
                validationPassed = true;
              }
            } else {
              yield { type: 'log', message: 'Correction returned empty, keeping original.' };
              validationPassed = true; // Exit loop, use what we have
            }

            correctionCycle++;
          } else {
            // Max corrections reached, proceed with warnings
            yield { type: 'log', message: 'Max correction cycles reached. Proceeding with current data.' };
            validationPassed = true;
          }
        } else {
          // Validation passed
          yield { type: 'log', message: 'Validation passed.' };
          validationPassed = true;
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[AgenticDoctor] Validation failed:', errorMessage);
        yield { type: 'log', message: `Validation error: ${errorMessage}. Proceeding with current data.` };
        validationPassed = true; // Exit loop on error
      }
    }

    yield { type: 'step', name: 'Validation', status: 'completed' };

    // ========================================================================
    // Phase 7: HTML Generation
    // Uses sendMessageStream with html-builder skill
    // DATA-DRIVEN: structured_data.json is the ONLY source - JSON drives structure
    // ========================================================================
    yield { type: 'step', name: 'Realm Generation', status: 'running' };
    yield { type: 'log', message: 'Building your Health Realm...' };

    const realmId = sessionId;
    const realmPath = LegacyPaths.realm(realmId);

    // Ensure realm directory exists
    await this.storage.ensureDir(LegacyPaths.realmDir(realmId));

    try {
      const htmlSkill = loadHTMLBuilderSkill();

      // DATA-DRIVEN: structured_data.json is the ONLY source of structure
      // The JSON fields determine what sections to render
      const htmlPrompt = `${htmlSkill}

---

### Structured Data (SOURCE OF TRUTH)
This JSON contains ALL data for rendering. Iterate through each field and render appropriate sections.
Only render sections for fields that have data. Do not invent sections not in this JSON.
<structured_data>
${structuredDataContent}
</structured_data>`;

      // Log payload size for debugging network issues
      const payloadSizeKB = Math.round(htmlPrompt.length / 1024);
      console.log(`[AgenticDoctor] HTML prompt payload: ${payloadSizeKB}KB (${htmlPrompt.length} chars)`);
      yield { type: 'log', message: `Generating interactive HTML experience (${payloadSizeKB}KB payload)...` };

      let htmlContent = '';
      const htmlStream = await this.llmClient.sendMessageStream(
        htmlPrompt,
        `${sessionId}-html`,
        undefined,
        { model: REALM_CONFIG.models.html }
      );

      for await (const chunk of htmlStream) {
        htmlContent += chunk;
      }

      if (htmlContent.trim().length === 0) {
        throw new Error('LLM returned empty HTML');
      }

      // Clean up the HTML
      htmlContent = htmlContent.trim();

      // Strip any thinking text before <!DOCTYPE
      const doctypeIndex = htmlContent.indexOf('<!DOCTYPE');
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
      console.log(`[AgenticDoctor] HTML Realm: ${htmlContent.length} chars`);

      yield { type: 'log', message: 'Initial HTML generation complete.' };
      yield { type: 'step', name: 'Realm Generation', status: 'completed' };

      // ========================================================================
      // Phase 8: Content Review
      // Compares structured_data.json against index.html to identify information loss
      // ========================================================================
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

        let reviewContent = '';
        const reviewStream = await this.llmClient.sendMessageStream(
          reviewPrompt,
          `${sessionId}-content-review`,
          undefined,
          { model: REALM_CONFIG.models.doctor }
        );

        for await (const chunk of reviewStream) {
          reviewContent += chunk;
        }

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

        yield { type: 'step', name: 'Content Review', status: 'completed' };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[AgenticDoctor] Content review failed:', errorMessage);
        yield { type: 'log', message: `Content review failed: ${errorMessage}. Proceeding with current HTML.` };
        yield { type: 'step', name: 'Content Review', status: 'failed' };
        contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } }; // Skip patching on error
      }

      // ========================================================================
      // Phase 9: HTML Regeneration (if needed)
      // If content review found issues, regenerate HTML with feedback
      // ========================================================================
      if (contentReviewResult.overall.action === 'regenerate_with_feedback' && contentReviewResult.overall.feedback_for_regeneration) {
        yield { type: 'step', name: 'HTML Regeneration', status: 'running' };
        yield { type: 'log', message: 'Regenerating HTML with reviewer feedback...' };

        try {
          const htmlSkill = loadHTMLBuilderSkill();

          // Build regeneration prompt with feedback
          const regenPrompt = `${htmlSkill}

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

## CRITICAL INSTRUCTIONS

1. Address EVERY issue in the feedback
2. Include ALL specific names, dosages, values, timings from the structured data
3. Do NOT genericize or summarize - use exact details from JSON
4. Make urgent/critical items visually prominent (callouts, warnings, colored boxes)
5. Preserve explanatory context - the WHY matters as much as the WHAT
6. Only render sections for fields that have data in the JSON

**Output the complete regenerated HTML now.**`;

          console.log(`[AgenticDoctor] Regeneration prompt payload: ${Math.round(regenPrompt.length / 1024)}KB`);

          let regenHtml = '';
          const regenStream = await this.llmClient.sendMessageStream(
            regenPrompt,
            `${sessionId}-html-regen`,
            undefined,
            { model: REALM_CONFIG.models.html }
          );

          for await (const chunk of regenStream) {
            regenHtml += chunk;
          }

          if (regenHtml.trim().length > 0) {
            // Clean up regenerated HTML
            regenHtml = regenHtml.trim();
            const regenDoctypeIndex = regenHtml.indexOf('<!DOCTYPE');
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

          yield { type: 'step', name: 'HTML Regeneration', status: 'completed' };

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[AgenticDoctor] HTML regeneration failed:', errorMessage);
          yield { type: 'log', message: `HTML regeneration failed: ${errorMessage}. Using original HTML.` };
          yield { type: 'step', name: 'HTML Regeneration', status: 'failed' };
        }
      }

      // Return the realm URL
      const realmUrl = `/realms/${realmId}/index.html`;

      yield { type: 'log', message: `Health Realm ready: ${realmUrl}` };
      yield { type: 'result', url: realmUrl };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] HTML generation failed:', errorMessage);
      yield { type: 'log', message: `Realm generation failed: ${errorMessage}` };
      yield { type: 'step', name: 'Realm Generation', status: 'failed' };
      yield { type: 'error', content: `HTML realm generation failed: ${errorMessage}` };
    }
  }
}
