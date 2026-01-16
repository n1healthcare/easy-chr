/**
 * AgenticDoctorUseCase - Medical Document Analysis Pipeline
 *
 * 7-Phase Pipeline:
 * Phase 1: Document Extraction - PDFs via Vision OCR, text files directly → extracted.md
 * Phase 2: Medical Analysis - LLM with medical-analysis skill → analysis.md
 * Phase 3: Cross-System Analysis - LLM identifies connections between systems → cross_systems.md
 * Phase 4: Synthesis - LLM merges insights into cohesive narrative → final_analysis.md
 * Phase 5: Validation - LLM validates completeness and accuracy → validation.md (with correction loop)
 * Phase 6: Data Structuring - LLM extracts chart-ready JSON → structured_data.json
 * Phase 7: Realm Generation - LLM with html-builder skill → interactive Health Realm (index.html)
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

import { LLMClientPort } from '../ports/llm-client.port.js';
import { readFileWithEncoding } from '../../../vendor/gemini-cli/packages/core/src/utils/fileUtils.js';
import { PDFExtractionService } from '../../services/pdf-extraction.service.js';
import { AgenticMedicalAnalyst, type AnalystEvent } from '../../services/agentic-medical-analyst.service.js';
import { REALM_CONFIG } from '../../config.js';
import type { RealmGenerationEvent } from '../../domain/types.js';

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

const loadSynthesizerSkill = () => loadSkill(
  'synthesizer',
  'You are a medical communication specialist. Merge analysis into a cohesive, prioritized narrative.'
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

    // ========================================================================
    // Phase 2: Agentic Medical Analysis
    // Uses iterative tool-based exploration instead of single-pass analysis
    // The agent explores the data, forms hypotheses, seeks evidence, and builds
    // comprehensive analysis through multiple exploration cycles
    // ========================================================================
    yield { type: 'step', name: 'Medical Analysis', status: 'running' };
    yield { type: 'log', message: 'Starting agentic medical analysis...' };

    const analysisPath = path.join(storageDir, 'analysis.md');
    let analysisContent = '';

    try {
      const agenticAnalyst = new AgenticMedicalAnalyst();

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

      await fs.promises.writeFile(analysisPath, analysisContent, 'utf-8');
      console.log(`[AgenticDoctor] Agentic analysis complete: ${analysisContent.length} chars`);

      yield { type: 'log', message: `Medical analysis complete (${analysisContent.length} chars)` };
      yield { type: 'step', name: 'Medical Analysis', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Agentic analysis failed:', errorMessage);
      yield { type: 'log', message: `Medical analysis failed: ${errorMessage}` };
      yield { type: 'step', name: 'Medical Analysis', status: 'failed' };
      yield { type: 'result', url: extractedPath };
      return;
    }

    // ========================================================================
    // Phase 3: Cross-System Analysis
    // Identifies connections between body systems
    // ========================================================================
    yield { type: 'step', name: 'Cross-System Analysis', status: 'running' };
    yield { type: 'log', message: 'Analyzing cross-system connections...' };

    const crossSystemsPath = path.join(storageDir, 'cross_systems.md');
    let crossSystemsContent = '';

    try {
      const crossSystemSkill = loadCrossSystemSkill();

      const crossSystemPrompt = `${crossSystemSkill}

---

## Input Data

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data
<extracted_data>
${allExtractedContent}
</extracted_data>

### Initial Medical Analysis
<analysis>
${analysisContent}
</analysis>

---

**Your Task:**
1. Identify all cross-system connections in this patient's data
2. Formulate root cause hypotheses that explain multiple findings
3. Map the relationships between affected systems
4. Note any expected connections that are NOT present
${prompt ? `5. Pay special attention to connections relevant to the patient's question` : ''}

**Output your cross-system analysis now:**`;

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

      await fs.promises.writeFile(crossSystemsPath, crossSystemsContent, 'utf-8');
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
    // Phase 4: Synthesis
    // Merges analysis and cross-system insights into cohesive narrative
    // ========================================================================
    yield { type: 'step', name: 'Synthesis', status: 'running' };
    yield { type: 'log', message: 'Synthesizing final analysis...' };

    const finalAnalysisPath = path.join(storageDir, 'final_analysis.md');
    let finalAnalysisContent = '';

    try {
      const synthesizerSkill = loadSynthesizerSkill();

      const synthesisPrompt = `${synthesizerSkill}

---

## Input Data

${prompt ? `### Patient's Original Question\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Initial Medical Analysis
<analysis>
${analysisContent}
</analysis>

### Cross-System Connections
<cross_systems>
${crossSystemsContent}
</cross_systems>

---

**Your Task:**
1. Merge the analysis and cross-system insights into ONE cohesive document
2. Organize by clinical priority, not by lab category
3. Weave connections INTO the narrative (don't separate them)
4. Write in patient-facing language
5. Create specific, prioritized action items
6. Cross-reference against extracted_data to ensure NO data points are omitted

**CRITICAL:** The extracted_data is your source of truth. If you notice any values or findings in extracted_data that were not covered in the analysis, YOU MUST include them in your synthesis.

**Output the synthesized final analysis now:**`;

      const synthesisStream = await this.llmClient.sendMessageStream(
        synthesisPrompt,
        `${sessionId}-synthesis`,
        undefined,
        { model: REALM_CONFIG.models.doctor }
      );

      for await (const chunk of synthesisStream) {
        finalAnalysisContent += chunk;
      }

      if (finalAnalysisContent.trim().length === 0) {
        throw new Error('LLM returned empty synthesis');
      }

      // Strip thinking text
      finalAnalysisContent = stripThinkingText(finalAnalysisContent, /^#\s+.+$/m);

      await fs.promises.writeFile(finalAnalysisPath, finalAnalysisContent, 'utf-8');
      console.log(`[AgenticDoctor] Synthesized analysis: ${finalAnalysisContent.length} chars`);

      yield { type: 'log', message: 'Synthesis complete.' };
      yield { type: 'step', name: 'Synthesis', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Synthesis failed:', errorMessage);
      yield { type: 'log', message: `Synthesis failed: ${errorMessage}. Using basic analysis.` };
      yield { type: 'step', name: 'Synthesis', status: 'failed' };
      // Fallback to basic analysis
      finalAnalysisContent = analysisContent;
      await fs.promises.writeFile(finalAnalysisPath, finalAnalysisContent, 'utf-8');
    }

    // ========================================================================
    // Phase 5: Validation with Feedback Loop
    // Validates analysis, and if issues found, sends corrections back to synthesizer
    // Maximum 1 correction cycle to avoid infinite loops
    // ========================================================================
    yield { type: 'step', name: 'Validation', status: 'running' };
    yield { type: 'log', message: 'Validating analysis completeness...' };

    const validationPath = path.join(storageDir, 'validation.md');
    const MAX_CORRECTION_CYCLES = 1;
    let correctionCycle = 0;
    let validationPassed = false;

    while (correctionCycle <= MAX_CORRECTION_CYCLES && !validationPassed) {
      try {
        const validatorSkill = loadValidatorSkill();

        const validationPrompt = `${validatorSkill}

---

## Input Data

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Final Synthesized Analysis (To Validate)
<final_analysis>
${finalAnalysisContent}
</final_analysis>

---

**Your Task:**
1. Check that EVERY data point (numeric AND qualitative) from extracted_data appears in final_analysis
2. Verify all calculations and percentages are correct
3. Ensure all claims are supported by the data
4. Check for internal consistency
5. Verify all recommendations trace to specific findings
6. Check that symptoms, medications, history, and context are preserved
${prompt ? `7. Verify the analysis adequately addresses the patient's question` : ''}

**Output your validation report now:**`;

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

        await fs.promises.writeFile(validationPath, validationContent, 'utf-8');
        console.log(`[AgenticDoctor] Validation report (cycle ${correctionCycle}): ${validationContent.length} chars`);

        // Check if validation passed or needs revision
        const needsRevision = validationContent.toLowerCase().includes('needs revision');
        const hasCriticalErrors = (validationContent.match(/❌/g) || []).length > 0;

        if (needsRevision || hasCriticalErrors) {
          yield { type: 'log', message: `Validation found issues that need correction.` };

          // If we haven't exceeded correction cycles, attempt to fix
          if (correctionCycle < MAX_CORRECTION_CYCLES) {
            yield { type: 'log', message: 'Sending corrections back to synthesizer...' };

            // Extract the "Required Corrections" section if present
            const correctionsMatch = validationContent.match(/## Required Corrections[\s\S]*?(?=##|$)/);
            const requiredCorrections = correctionsMatch ? correctionsMatch[0] : '';

            // Create correction prompt for synthesizer
            const synthesizerSkill = loadSynthesizerSkill();
            const correctionPrompt = `${synthesizerSkill}

---

## CORRECTION TASK

The previous synthesis was validated and found to have issues that need correction.

${prompt ? `### Patient's Original Question\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Previous Synthesis (Has Issues)
<previous_synthesis>
${finalAnalysisContent}
</previous_synthesis>

### Validation Report
<validation_report>
${validationContent}
</validation_report>

${requiredCorrections ? `### Required Corrections (MUST FIX)\n${requiredCorrections}` : ''}

---

**Your Task:**
You MUST produce a CORRECTED version of the synthesis that:
1. Fixes ALL issues identified in the validation report
2. Adds any missing data points from extracted_data
3. Corrects any calculation errors
4. Removes or properly hedges unsupported claims
5. Preserves all context (medications, symptoms, history)
6. Addresses the patient's question (if provided)

**IMPORTANT:**
- Do NOT just acknowledge the errors - actually FIX them in the output
- Include ALL data from extracted_data
- Your output should be a complete, corrected final analysis

**Output the CORRECTED synthesized final analysis now:**`;

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
              // Strip thinking text
              correctedContent = stripThinkingText(correctedContent, /^#\s+.+$/m);

              // Update finalAnalysisContent with corrected version
              finalAnalysisContent = correctedContent;
              await fs.promises.writeFile(finalAnalysisPath, finalAnalysisContent, 'utf-8');
              console.log(`[AgenticDoctor] Corrected synthesis: ${finalAnalysisContent.length} chars`);
              yield { type: 'log', message: 'Synthesis corrected. Re-validating...' };
            } else {
              yield { type: 'log', message: 'Correction returned empty, keeping original.' };
              validationPassed = true; // Exit loop, use what we have
            }

            correctionCycle++;
          } else {
            // Max corrections reached, proceed with warnings
            yield { type: 'log', message: 'Max correction cycles reached. Proceeding with current analysis.' };
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
        yield { type: 'log', message: `Validation error: ${errorMessage}. Proceeding with current analysis.` };
        validationPassed = true; // Exit loop on error
      }
    }

    yield { type: 'step', name: 'Validation', status: 'completed' };

    // ========================================================================
    // Phase 6: Data Structuring
    // Extracts chart-ready JSON from all analysis data
    // ========================================================================
    yield { type: 'step', name: 'Data Structuring', status: 'running' };
    yield { type: 'log', message: 'Extracting structured data for visualizations...' };

    const structuredDataPath = path.join(storageDir, 'structured_data.json');
    let structuredDataContent = '';

    try {
      const dataStructurerSkill = loadDataStructurerSkill();

      const structurePrompt = `${dataStructurerSkill}

---

## Input Data (4 Sources)

You have FOUR input sources. Use them in this priority order:

### Priority 1: Rich Medical Analysis (PRIMARY for diagnoses, timeline, prognosis, supplements)
This contains the most detailed analysis with all rich sections.
<analysis>
${analysisContent}
</analysis>

### Priority 2: Cross-System Connections (for mechanism explanations)
<cross_systems>
${crossSystemsContent}
</cross_systems>

### Priority 3: Final Synthesized Analysis (for patient-facing narrative)
<final_analysis>
${finalAnalysisContent}
</final_analysis>

### Priority 4: Original Extracted Data (source of truth for raw values)
${prompt ? `#### Patient's Question/Context\n${prompt}\n\n` : ''}<extracted_data>
${allExtractedContent}
</extracted_data>

---

## Extraction Priority Rules

1. **For diagnoses[], timeline[], prognosis, supplementSchedule, lifestyleOptimizations, monitoringProtocol[], doctorQuestions[]:**
   → Extract from <analysis> FIRST (it has the richest content)
   → Fill gaps from <final_analysis>

2. **For connections[]:**
   → Extract from <cross_systems> (it has detailed mechanisms)

3. **For allFindings[], criticalFindings[], trends[]:**
   → Use values from <extracted_data> (source of truth for numbers)
   → Use status/interpretation from <analysis>

4. **For systemsHealth, actionPlan:**
   → Extract from <analysis> or <final_analysis>

---

**Your Task:**
Extract ALL data into the structured JSON format specified in your instructions.

**CRITICAL:**
- Output ONLY valid JSON - no markdown, no explanation
- Include EVERY value from extracted_data in the allFindings array
- Include EVERY connection from cross_systems in the connections array
- Extract ALL rich sections from analysis (diagnoses, timeline, prognosis, supplements, lifestyle, monitoring, doctor questions)
- Include ALL symptoms, medications, and history in qualitativeData

**Output the JSON now (starting with {):**`;

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

      await fs.promises.writeFile(structuredDataPath, structuredDataContent, 'utf-8');

      yield { type: 'log', message: 'Data structuring complete.' };
      yield { type: 'step', name: 'Data Structuring', status: 'completed' };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] Data structuring failed:', errorMessage);
      yield { type: 'log', message: `Data structuring failed: ${errorMessage}. HTML will use narrative only.` };
      yield { type: 'step', name: 'Data Structuring', status: 'failed' };
      // Continue with empty structured data - HTML can still work from narrative
      structuredDataContent = '{}';
      await fs.promises.writeFile(structuredDataPath, structuredDataContent, 'utf-8');
    }

    // ========================================================================
    // Phase 7: HTML Generation
    // Uses sendMessageStream with html-builder skill
    // Receives both narrative (final_analysis.md) and structured data (structured_data.json)
    // ========================================================================
    yield { type: 'step', name: 'Realm Generation', status: 'running' };
    yield { type: 'log', message: 'Building your Health Realm...' };

    const realmId = sessionId;
    const realmDir = path.join(storageDir, 'realms', realmId);
    const htmlPath = path.join(realmDir, 'index.html');

    // Ensure realm directory exists
    if (!fs.existsSync(realmDir)) {
      fs.mkdirSync(realmDir, { recursive: true });
    }

    try {
      const htmlSkill = loadHTMLBuilderSkill();

      // Use ALL sources: structured data, analysis, cross-systems, and final analysis
      const htmlPrompt = `${htmlSkill}

---

## Input Data (4 Sources with Priority Order)

You have FOUR inputs. Use them in this priority order for different content types:

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}

### Priority 1: Structured Data (for charts and visualizations)
Use this for ALL numeric visualizations - it has exact values ready for SVG rendering.
<structured_data>
${structuredDataContent}
</structured_data>

### Priority 2: Rich Medical Analysis (for detailed sections)
Use this for diagnoses, timeline, prognosis, supplements, lifestyle, monitoring protocol, doctor questions.
This has the MOST DETAILED content - do NOT skip sections that exist here!
<analysis>
${analysisContent}
</analysis>

### Priority 3: Cross-System Analysis (for mechanism explanations)
Use this for flow diagrams, cause→effect relationships, and root cause explanations.
<cross_systems>
${crossSystemsContent}
</cross_systems>

### Priority 4: Final Synthesized Analysis (for patient-facing narrative)
Use this for polished, patient-friendly text explanations and the "big picture" story.
<final_analysis>
${finalAnalysisContent}
</final_analysis>

---

## Content Type → Source Priority Matrix

| What You're Building | Primary Source | Secondary Source |
|---------------------|----------------|------------------|
| **Gauge charts, bar charts, line charts** | structured_data (exact values) | - |
| **Radar/spider charts** | structured_data.systemsHealth | - |
| **Trend charts** | structured_data.trends | - |
| **Flow diagrams** | structured_data.connections + cross_systems (mechanisms) | - |
| **Diagnoses cards** | structured_data.diagnoses OR analysis | final_analysis |
| **Timeline section** | structured_data.timeline OR analysis | final_analysis |
| **Prognosis section** | structured_data.prognosis OR analysis | final_analysis |
| **Supplement schedule** | structured_data.supplementSchedule OR analysis | final_analysis |
| **Lifestyle recommendations** | structured_data.lifestyleOptimizations OR analysis | final_analysis |
| **Monitoring protocol** | structured_data.monitoringProtocol OR analysis | final_analysis |
| **Doctor questions** | structured_data.doctorQuestions OR analysis | final_analysis |
| **Data tables (all findings)** | structured_data.allFindings | - |
| **Narrative text/explanations** | final_analysis | analysis |
| **Mechanism explanations** | cross_systems | analysis |
| **Action plan timeline** | structured_data.actionPlan | analysis |

---

## CRITICAL Instructions

1. **For charts/gauges/visualizations:** Use EXACT values from structured_data - don't approximate
2. **For rich sections:** Check structured_data first, then analysis - include ALL sections that exist
3. **For narrative:** Use final_analysis for patient-friendly language
4. **For mechanisms:** Use cross_systems for detailed cause→effect explanations
5. **EVERY data point should appear somewhere** - don't drop information
6. **If a section exists in analysis but not structured_data**, still include it using the analysis content
7. **Make critical findings impossible to miss** - prominent placement, visual emphasis

---

**Remember:**
- You are an intelligent data storyteller designing a COMPREHENSIVE health report
- Include ALL sections from the analysis - diagnoses, timeline, prognosis, supplements, lifestyle, monitoring, questions
- The structured_data has chart-ready values - USE THEM for accurate visualizations
- The analysis has rich content - USE IT for detailed sections
- The cross_systems has mechanisms - USE IT for flow diagrams and explanations
- The final_analysis has polished narrative - USE IT for text content
${prompt ? `- The patient asked: "${prompt}" - make sure this is prominently addressed` : ''}

**Output the complete HTML file now (starting with <!DOCTYPE html>):**`;

      yield { type: 'log', message: 'Generating interactive HTML experience...' };

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
      await fs.promises.writeFile(htmlPath, htmlContent, 'utf-8');
      console.log(`[AgenticDoctor] HTML Realm: ${htmlContent.length} chars`);

      // Return the realm URL
      const realmUrl = `/realms/${realmId}/index.html`;

      yield { type: 'log', message: 'Health Realm generation complete.' };
      yield { type: 'step', name: 'Realm Generation', status: 'completed' };
      yield { type: 'log', message: `Health Realm ready: ${realmUrl}` };
      yield { type: 'result', url: realmUrl };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[AgenticDoctor] HTML generation failed:', errorMessage);
      yield { type: 'log', message: `Realm generation failed: ${errorMessage}` };
      yield { type: 'step', name: 'Realm Generation', status: 'failed' };
      yield { type: 'result', url: finalAnalysisPath };
    }
  }
}
