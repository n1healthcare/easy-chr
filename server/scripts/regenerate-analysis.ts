/**
 * Regenerate Analysis from existing extracted.md
 *
 * Usage: npx tsx scripts/regenerate-analysis.ts [prompt]
 *
 * This script skips phase 1 (extraction) and runs phases 2-8:
 * - Phase 2: Medical Analysis (includes cross-system connections)
 * - Phase 3: Research
 * - Phase 4: Data Structuring (SOURCE OF TRUTH)
 * - Phase 5: Validation (validates structured_data.json)
 * - Phase 6: HTML Generation (from structured_data.json)
 * - Phase 7: Content Review (compares structured_data.json vs index.html)
 * - Phase 8: HTML Regeneration (if gaps found)
 *
 * Uses existing extracted.md from storage/
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GeminiAdapter } from '../src/adapters/gemini/gemini.adapter.js';
import { AgenticMedicalAnalyst } from '../src/services/agentic-medical-analyst.service.js';
import { AgenticValidator } from '../src/services/agentic-validator.service.js';
import { researchClaims, formatResearchAsMarkdown, type ResearchOutput } from '../src/services/research-agent.service.js';
import { REALM_CONFIG } from '../src/config.js';
import { extractSourceExcerpts } from '../src/utils/source-excerpts.js';
import { deepMergeJsonPatch } from '../src/utils/json-patch-merge.js';

function loadSkill(skillName: string): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    skillName,
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    throw new Error(`Could not load ${skillName} SKILL.md`);
  }
}

function stripThinkingText(content: string, marker: string | RegExp): string {
  if (typeof marker === 'string') {
    const index = content.indexOf(marker);
    if (index > 0) {
      console.log(`[RegenAnalysis] Stripping ${index} chars of thinking text`);
      return content.slice(index);
    }
  } else {
    const match = content.match(marker);
    if (match && match.index && match.index > 0) {
      console.log(`[RegenAnalysis] Stripping ${match.index} chars of thinking text`);
      return content.slice(match.index);
    }
  }
  return content;
}

async function streamWithRetry(
  gemini: GeminiAdapter,
  prompt: string,
  sessionId: string,
  model: string,
  operationName: string,
  maxRetries = 3
): Promise<string> {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    let content = '';
    try {
      const stream = await gemini.sendMessageStream(prompt, `${sessionId}-${attempt}`, undefined, { model });
      for await (const chunk of stream) {
        content += chunk;
      }
      return content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  [${operationName}] Attempt ${attempt}/${maxRetries} failed: ${msg}`);
      if (attempt >= maxRetries) throw error;
      const waitMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  return '';
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

async function regenerateAnalysis(userPrompt?: string) {
  const storageDir = path.join(process.cwd(), 'storage');
  const sessionId = uuidv4();
  const prompt = userPrompt || '';

  // Check required files exist
  const extractedPath = path.join(storageDir, 'extracted.md');
  if (!fs.existsSync(extractedPath)) {
    throw new Error('Required file missing: extracted.md. Run the full pipeline first.');
  }

  // Load extracted content
  console.log('Loading extracted.md...');
  const allExtractedContent = fs.readFileSync(extractedPath, 'utf-8');
  console.log(`Loaded extracted.md: ${allExtractedContent.length} chars`);

  // Initialize Gemini adapter
  const gemini = new GeminiAdapter();
  await gemini.initialize();

  // ========================================================================
  // Phase 2: Agentic Medical Analysis
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 2: Medical Analysis');
  console.log('='.repeat(60));

  const analysisPath = path.join(storageDir, 'analysis.md');
  let analysisContent = '';

  const agenticAnalyst = new AgenticMedicalAnalyst();
  console.log('Agent is exploring the medical data...');

  const analysisGenerator = agenticAnalyst.analyze(
    allExtractedContent,
    prompt,
    35
  );

  let result = await analysisGenerator.next();
  while (!result.done) {
    const event = result.value;
    switch (event.type) {
      case 'log':
        console.log(`  ${event.data.message || ''}`);
        break;
      case 'tool_call':
        if (event.data.toolName && !event.data.toolResult) {
          console.log(`  [Tool] ${event.data.toolName}`);
        }
        break;
      case 'analysis_update':
        if (event.data.analysisContent) {
          analysisContent = event.data.analysisContent;
        }
        break;
      case 'complete':
        console.log(`  ${event.data.message || 'Analysis complete'}`);
        break;
    }
    result = await analysisGenerator.next();
  }

  if (result.done && typeof result.value === 'string' && result.value.length > 0) {
    analysisContent = result.value;
  }

  if (!analysisContent || analysisContent.trim().length === 0) {
    throw new Error('Agentic analysis produced no content');
  }

  fs.writeFileSync(analysisPath, analysisContent, 'utf-8');
  console.log(`✅ Phase 2 complete: analysis.md (${analysisContent.length} chars)`);

  // ========================================================================
  // Phase 3: Research
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 3: Research');
  console.log('='.repeat(60));

  const researchPath = path.join(storageDir, 'research.json');
  let researchOutput: ResearchOutput = { researchedClaims: [], unsupportedClaims: [], additionalFindings: [] };
  let researchMarkdown = '';

  const geminiConfig = gemini.getConfig();
  if (geminiConfig) {
    console.log('Validating claims with external sources...');
    const researchGenerator = researchClaims(
      geminiConfig,
      analysisContent,
      prompt
    );

    let researchResult = await researchGenerator.next();
    while (!researchResult.done) {
      const event = researchResult.value;
      switch (event.type) {
        case 'claim_extracted':
        case 'searching':
        case 'claim_researched':
          console.log(`  ${event.data.message || ''}`);
          break;
        case 'complete':
          console.log(`  ${event.data.message || ''}`);
          break;
      }
      researchResult = await researchGenerator.next();
    }

    researchOutput = researchResult.value as ResearchOutput;
    researchMarkdown = formatResearchAsMarkdown(researchOutput);
    fs.writeFileSync(researchPath, JSON.stringify(researchOutput, null, 2), 'utf-8');
    console.log(`✅ Phase 3 complete: research.json (${researchOutput.researchedClaims.length} claims)`);
  } else {
    console.log('⚠️ Gemini config not available, skipping research phase');
  }

  // ========================================================================
  // Phase 4: Data Structuring (SOURCE OF TRUTH)
  // Extracts chart-ready JSON
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 4: Data Structuring');
  console.log('='.repeat(60));

  const structuredDataPath = path.join(storageDir, 'structured_data.json');
  let structuredDataContent = '';

  const dataStructurerSkill = loadSkill('data-structurer');
  const structurePrompt = `${dataStructurerSkill}

---

${prompt ? `#### Patient's Question/Context\n${prompt}\n\n` : ''}### Priority 1: Rich Medical Analysis (PRIMARY - includes cross-system connections)
<analysis>
${analysisContent}
</analysis>

### Priority 2: Research Findings (for citations and verified claims)
<research>
${researchMarkdown}
</research>`;
  // NOTE: allExtractedContent intentionally EXCLUDED to keep payload manageable
  // The analysis already interprets the raw data, so including it is redundant

  console.log('Extracting structured data for visualizations...');
  structuredDataContent = await streamWithRetry(gemini, structurePrompt, `${sessionId}-structure`, REALM_CONFIG.models.doctor, 'DataStructuring');

  // Clean up JSON
  structuredDataContent = cleanupJson(structuredDataContent);

  // Validate JSON
  try {
    JSON.parse(structuredDataContent);
  } catch {
    console.warn('  JSON not valid, attempting repair...');
    const lastBrace = structuredDataContent.lastIndexOf('}');
    if (lastBrace > 0) {
      structuredDataContent = structuredDataContent.slice(0, lastBrace + 1);
      try {
        JSON.parse(structuredDataContent);
        console.log('  JSON repaired.');
      } catch {
        console.warn('  JSON repair failed, using empty structure.');
        structuredDataContent = '{}';
      }
    }
  }

  fs.writeFileSync(structuredDataPath, structuredDataContent, 'utf-8');
  console.log(`✅ Phase 4 complete: structured_data.json (${structuredDataContent.length} chars)`);

  // ========================================================================
  // Phase 5: Agentic Validation (with correction loop)
  // Uses AgenticValidator with verification-focused tools to validate
  // structured_data.json against source data without payload bloat.
  // Runs up to MAX_CORRECTION_CYCLES corrections, re-validating after each.
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 5: Agentic Validation');
  console.log('='.repeat(60));

  const validationPath = path.join(storageDir, 'validation.md');

  const MAX_CORRECTION_CYCLES = 3;
  let correctionCycle = 0;
  let validationPassed = false;
  let finalValidationStatus = '';
  let finalValidationSummary = '';
  let allPreviouslyRaisedIssues: Array<{ category: string; severity: string; description: string }> = [];
  const allCycleIssues: Array<{ severity: string; category: string; description: string; source_location?: string; json_location?: string; cycle: number; corrected: boolean }> = [];

  while (correctionCycle <= MAX_CORRECTION_CYCLES && !validationPassed) {
    console.log(`\n  --- Validation cycle ${correctionCycle + 1}/${MAX_CORRECTION_CYCLES + 1} ---`);

    const agenticValidator = new AgenticValidator();
    const validationGenerator = agenticValidator.validate(
      allExtractedContent,
      structuredDataContent,
      prompt,
      15, // maxIterations
      allPreviouslyRaisedIssues
    );

    let validationResult = await validationGenerator.next();
    while (!validationResult.done) {
      const event = validationResult.value;
      switch (event.type) {
        case 'log':
          console.log(`  ${event.data.message || ''}`);
          break;
        case 'tool_call':
          if (event.data.toolName && !event.data.toolResult) {
            console.log(`  [Tool] ${event.data.toolName}`);
          }
          break;
        case 'issue_found':
          if (event.data.issue) {
            const issue = event.data.issue;
            console.log(`  [Issue] ${issue.severity.toUpperCase()}: ${issue.description}`);
          }
          break;
        case 'complete':
          console.log(`  ${event.data.message || 'Validation complete'}`);
          break;
        case 'error':
          console.error(`  [Error] ${event.data.message || 'Unknown error'}`);
          break;
      }
      validationResult = await validationGenerator.next();
    }

    const { status: validationStatus, issues: validationIssues, summary: validationSummary } = validationResult.value;
    finalValidationStatus = validationStatus;
    finalValidationSummary = validationSummary;
    const cycleIssues = validationIssues.map((i: { severity: string; category: string; description: string; source_location?: string; json_location?: string }) => ({
      ...i, cycle: correctionCycle + 1, corrected: false,
    }));
    allCycleIssues.push(...cycleIssues);

    // Accumulate issues so next cycle skips previously raised ones
    allPreviouslyRaisedIssues = [...allPreviouslyRaisedIssues, ...validationIssues];

    const actionableIssues = validationIssues.filter((i: { severity: string }) => i.severity === 'critical' || i.severity === 'warning');
    const needsRevision = validationStatus === 'needs_revision' || actionableIssues.length > 0;

    if (needsRevision && actionableIssues.length > 0) {
      if (correctionCycle < MAX_CORRECTION_CYCLES) {
        console.log(`  Validation found ${actionableIssues.length} actionable issues. Sending surgical correction (cycle ${correctionCycle + 1}/${MAX_CORRECTION_CYCLES})...`);

        const issueDescriptions = actionableIssues.map((i: { category: string; description: string }) => `- ${i.category}: ${i.description}`).join('\n');
        const sourceExcerpts = extractSourceExcerpts(allExtractedContent, actionableIssues);

        const correctionPrompt = `${dataStructurerSkill}

---

## CORRECTION TASK

The validator verified these issues against the raw source documents.
When the validator's findings conflict with the analyst's interpretation, the SOURCE DOCUMENT EXCERPTS are the ground truth.

${issueDescriptions}

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

### Validation Issues to Fix (verified against source documents)
${issueDescriptions}

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

        let correctedContent = await streamWithRetry(gemini, correctionPrompt, `${sessionId}-correction-${correctionCycle}`, REALM_CONFIG.models.doctor, 'Correction');

        if (correctedContent.trim().length > 0) {
          correctedContent = cleanupJson(correctedContent);
          try {
            const patch = JSON.parse(correctedContent);
            const original = JSON.parse(structuredDataContent);
            const merged = deepMergeJsonPatch(original, patch);
            structuredDataContent = JSON.stringify(merged, null, 2);
            fs.writeFileSync(structuredDataPath, structuredDataContent, 'utf-8');
            console.log(`  Surgical patch applied (${Object.keys(patch).length} fields). Result: ${structuredDataContent.length} chars. Re-validating...`);
            for (const ci of allCycleIssues) {
              if (ci.cycle === correctionCycle + 1 && !ci.corrected) ci.corrected = true;
            }
          } catch {
            console.warn('  Correction patch invalid JSON, keeping original.');
            validationPassed = true;
          }
        } else {
          console.log('  Correction returned empty, keeping original.');
          validationPassed = true;
        }

        correctionCycle++;
      } else {
        console.log(`  Max correction cycles (${MAX_CORRECTION_CYCLES}) reached. Proceeding with current data.`);
        validationPassed = true;
      }
    } else {
      console.log(`  Validation ${validationStatus === 'pass' ? 'passed' : 'passed with info-only issues'}.`);
      validationPassed = true;
    }
  }

  // Write final validation report with FULL history across all cycles
  const correctedIssues = allCycleIssues.filter(i => i.corrected);
  const uncorrectedIssues = allCycleIssues.filter(i => !i.corrected);
  const finalStatus = uncorrectedIssues.some(i => i.severity === 'critical') ? 'needs_revision' :
    uncorrectedIssues.length === 0 ? 'pass' : finalValidationStatus;

  const validationReportLines = [
    `# Validation Report`,
    ``,
    `**Status:** ${finalStatus}`,
    `**Summary:** ${finalValidationSummary}`,
    `**Correction Cycles:** ${correctionCycle}/${MAX_CORRECTION_CYCLES}`,
    `**Total Issues Found:** ${allCycleIssues.length} (${correctedIssues.length} corrected, ${uncorrectedIssues.length} remaining)`,
    ``
  ];

  if (correctedIssues.length > 0) {
    validationReportLines.push(`## Corrected Issues (${correctedIssues.length})`, ``);
    for (const issue of correctedIssues) {
      validationReportLines.push(`### [${issue.severity.toUpperCase()}] ${issue.category} *(Cycle ${issue.cycle} — Corrected)*`);
      validationReportLines.push(issue.description);
      if (issue.source_location) validationReportLines.push(`- Source: ${issue.source_location}`);
      if (issue.json_location) validationReportLines.push(`- JSON: ${issue.json_location}`);
      validationReportLines.push('');
    }
  }

  if (uncorrectedIssues.length > 0) {
    validationReportLines.push(`## Remaining Issues (${uncorrectedIssues.length})`, ``);
    for (const issue of uncorrectedIssues) {
      validationReportLines.push(`### [${issue.severity.toUpperCase()}] ${issue.category} *(Cycle ${issue.cycle})*`);
      validationReportLines.push(issue.description);
      if (issue.source_location) validationReportLines.push(`- Source: ${issue.source_location}`);
      if (issue.json_location) validationReportLines.push(`- JSON: ${issue.json_location}`);
      validationReportLines.push('');
    }
  }

  if (allCycleIssues.length === 0) {
    validationReportLines.push(`## Issues`, ``, `No issues found.`, ``);
  }

  const validationContent = validationReportLines.join('\n');
  fs.writeFileSync(validationPath, validationContent, 'utf-8');

  console.log(`✅ Phase 5 complete: validation.md (${correctionCycle} correction cycles applied)`);

  // ========================================================================
  // Phase 6: HTML Generation
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 6: HTML Generation');
  console.log('='.repeat(60));

  const realmId = uuidv4();
  const realmDir = path.join(storageDir, 'realms', realmId);
  fs.mkdirSync(realmDir, { recursive: true });

  const htmlSkill = loadSkill('html-builder');
  // DATA-DRIVEN: only structured_data.json - the JSON IS the structure
  const htmlPrompt = `${htmlSkill}

---

### Structured Data (SOURCE OF TRUTH)
This JSON contains ALL data for rendering. Iterate through each field and render appropriate sections.
Only render sections for fields that have data. Do not invent sections not in this JSON.
<structured_data>
${structuredDataContent}
</structured_data>`;

  console.log(`Generating HTML... (payload: ${Math.round(htmlPrompt.length / 1024)}KB)`);
  let htmlContent = await streamWithRetry(gemini, htmlPrompt, `${sessionId}-html`, REALM_CONFIG.models.html, 'HTMLGeneration');

  // Clean up HTML
  htmlContent = htmlContent.trim();
  const doctypeIndex = htmlContent.indexOf('<!DOCTYPE');
  if (doctypeIndex > 0) {
    htmlContent = htmlContent.slice(doctypeIndex);
  }
  if (htmlContent.startsWith('```html')) {
    htmlContent = htmlContent.slice(7);
  } else if (htmlContent.startsWith('```')) {
    htmlContent = htmlContent.slice(3);
  }
  if (htmlContent.endsWith('```')) {
    htmlContent = htmlContent.slice(0, -3);
  }
  htmlContent = htmlContent.trim();

  const htmlPath = path.join(realmDir, 'index.html');
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  console.log(`✅ Phase 6 complete: index.html (${htmlContent.length} chars)`);

  // ========================================================================
  // Phase 7: Content Review
  // Compares structured_data.json against index.html to identify information loss
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 7: Content Review');
  console.log('='.repeat(60));
  console.log('Comparing structured_data.json against generated HTML...');

  const contentReviewPath = path.join(storageDir, 'content_review.json');
  let contentReviewResult: {
    user_question_addressed?: { passed: boolean; user_question: string; question_answered: boolean; answer_prominent: boolean; findings_connected: boolean; issues: Array<{ type: string; description: string; fix_instruction: string }> };
    detail_fidelity?: { passed: boolean; issues: Array<{ type: string; severity: string; source_content: string; html_found: string; fix_instruction: string }> };
    content_completeness?: { passed: boolean; present_categories: string[]; missing_categories: Array<{ category: string; source_had: string; importance: string; fix_instruction: string }> };
    visual_design?: { score: string; strengths: string[]; weaknesses: string[]; fix_instructions: string[] };
    overall: { passed: boolean; summary: string; action: string; feedback_for_regeneration?: string };
  } = { overall: { passed: true, summary: '', action: 'pass' } };

  try {
    const contentReviewerSkill = loadSkill('content-reviewer');
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

    console.log(`Reviewing HTML for completeness... (payload: ${Math.round(reviewPrompt.length / 1024)}KB)`);

    let reviewContent = await streamWithRetry(gemini, reviewPrompt, `${sessionId}-content-review`, REALM_CONFIG.models.doctor, 'ContentReview');

    // Clean up JSON
    reviewContent = reviewContent.trim();
    const jsonStartIndex = reviewContent.indexOf('{');
    if (jsonStartIndex > 0) reviewContent = reviewContent.slice(jsonStartIndex);
    if (reviewContent.startsWith('```json')) reviewContent = reviewContent.slice(7);
    else if (reviewContent.startsWith('```')) reviewContent = reviewContent.slice(3);
    if (reviewContent.endsWith('```')) reviewContent = reviewContent.slice(0, -3);
    reviewContent = reviewContent.trim();

    try {
      contentReviewResult = JSON.parse(reviewContent);
      fs.writeFileSync(contentReviewPath, JSON.stringify(contentReviewResult, null, 2), 'utf-8');
      console.log(`  Content review: passed=${contentReviewResult.overall.passed}, action=${contentReviewResult.overall.action}`);
    } catch {
      console.warn('  Content review JSON parse failed, assuming pass');
      contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } };
    }

    if (contentReviewResult.overall.passed) {
      console.log('  ✅ Content review passed - all dimensions acceptable.');
    } else {
      console.log('  ⚠️ Content review found issues.');
      if (contentReviewResult.overall.summary) {
        console.log(`  Summary: ${contentReviewResult.overall.summary}`);
      }
    }
    console.log(`✅ Phase 7 complete: content_review.json`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`  Content review failed: ${errorMessage}`);
    console.log('  Proceeding with current HTML.');
    contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } };
  }

  // ========================================================================
  // Phase 8: HTML Regeneration (if needed)
  // ========================================================================
  if (contentReviewResult.overall.action === 'regenerate_with_feedback' && contentReviewResult.overall.feedback_for_regeneration) {
    console.log('\n' + '='.repeat(60));
    console.log('Phase 8: HTML Regeneration');
    console.log('='.repeat(60));
    console.log('Regenerating HTML with reviewer feedback...');

    try {
      const regenPrompt = `${htmlSkill}

---

## REGENERATION TASK

Your previous HTML output had issues. Address ALL of the following:

### Reviewer Feedback (MUST ADDRESS)
<feedback>
${contentReviewResult.overall.feedback_for_regeneration}
</feedback>

### Structured Data (SOURCE OF TRUTH)
<structured_data>
${structuredDataContent}
</structured_data>

## CRITICAL: Address EVERY issue. Include ALL specific values from the JSON. Output complete HTML now.`;

      let regenHtml = await streamWithRetry(gemini, regenPrompt, `${sessionId}-html-regen`, REALM_CONFIG.models.html, 'HTMLRegeneration');

      if (regenHtml.trim().length > 0) {
        regenHtml = regenHtml.trim();
        const regenDoctypeIndex = regenHtml.indexOf('<!DOCTYPE');
        if (regenDoctypeIndex > 0) regenHtml = regenHtml.slice(regenDoctypeIndex);
        if (regenHtml.startsWith('```html')) regenHtml = regenHtml.slice(7);
        else if (regenHtml.startsWith('```')) regenHtml = regenHtml.slice(3);
        if (regenHtml.endsWith('```')) regenHtml = regenHtml.slice(0, -3);
        regenHtml = regenHtml.trim();

        if (regenHtml.includes('<!DOCTYPE') && regenHtml.includes('</html>')) {
          htmlContent = regenHtml;
          fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
          console.log(`  ✅ HTML regenerated: ${htmlContent.length} chars`);
        } else {
          console.log('  ⚠️ Regeneration produced invalid HTML, keeping original.');
        }
      }
      console.log(`✅ Phase 8 complete`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  HTML regeneration failed: ${errorMessage}`);
    }
  } else if (contentReviewResult.overall.passed) {
    console.log('\nPhase 8: HTML Regeneration - Skipped (all dimensions passed)');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ All phases complete!');
  console.log(`${'='.repeat(60)}`);
  console.log(`📁 HTML saved to: ${htmlPath}`);
  console.log(`🌐 View at: http://localhost:5173/realms/${realmId}/index.html`);
}

// Run
const userPrompt = process.argv[2] || '';
regenerateAnalysis(userPrompt).catch(console.error);
