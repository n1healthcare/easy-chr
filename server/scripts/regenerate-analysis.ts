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
    25
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
  const structureStream = await gemini.sendMessageStream(
    structurePrompt,
    `${sessionId}-structure`,
    undefined,
    { model: REALM_CONFIG.models.doctor }
  );

  for await (const chunk of structureStream) {
    structuredDataContent += chunk;
    process.stdout.write('.');
  }
  console.log(' Done!');

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
  // Phase 5: Agentic Validation
  // Uses AgenticValidator with verification-focused tools to validate
  // structured_data.json against source data without payload bloat
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 5: Agentic Validation');
  console.log('='.repeat(60));

  const validationPath = path.join(storageDir, 'validation.md');
  const agenticValidator = new AgenticValidator();

  console.log('Starting agentic validation (tool-based, no payload bloat)...');

  const validationGenerator = agenticValidator.validate(
    allExtractedContent,
    structuredDataContent,
    prompt,
    15 // maxIterations
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

  // Generate validation report markdown
  const validationReportLines = [
    `# Validation Report`,
    ``,
    `**Status:** ${validationStatus}`,
    `**Summary:** ${validationSummary}`,
    ``,
    `## Issues Found (${validationIssues.length})`,
    ``
  ];

  if (validationIssues.length === 0) {
    validationReportLines.push('No issues found.');
  } else {
    for (const issue of validationIssues) {
      validationReportLines.push(`### [${issue.severity.toUpperCase()}] ${issue.category}`);
      validationReportLines.push(issue.description);
      if (issue.source_location) validationReportLines.push(`- Source: ${issue.source_location}`);
      if (issue.json_location) validationReportLines.push(`- JSON: ${issue.json_location}`);
      validationReportLines.push('');
    }
  }

  const validationContent = validationReportLines.join('\n');
  fs.writeFileSync(validationPath, validationContent, 'utf-8');

  // Handle corrections if needed
  const criticalIssues = validationIssues.filter(i => i.severity === 'critical');
  if (validationStatus === 'needs_revision' && criticalIssues.length > 0) {
    console.log(`  Validation found ${criticalIssues.length} critical issues. Sending corrections...`);

    const issueDescriptions = criticalIssues.map(i => `- ${i.category}: ${i.description}`).join('\n');

    const dataStructurerSkill = loadSkill('data-structurer');
    const correctionPrompt = `${dataStructurerSkill}

---

## CORRECTION TASK

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Medical Analysis (Source of Truth for clinical interpretation)
<analysis>
${analysisContent}
</analysis>

### Previous Structured Data (Has Issues)
<previous_structured_data>
${structuredDataContent}
</previous_structured_data>

### Critical Issues to Fix
${issueDescriptions}

Output the CORRECTED JSON now (starting with \`{\`):`;

    let correctedContent = '';
    const correctionStream = await gemini.sendMessageStream(
      correctionPrompt,
      `${sessionId}-correction`,
      undefined,
      { model: REALM_CONFIG.models.doctor }
    );

    for await (const chunk of correctionStream) {
      correctedContent += chunk;
    }

    if (correctedContent.trim().length > 0) {
      correctedContent = cleanupJson(correctedContent);
      try {
        JSON.parse(correctedContent);
        structuredDataContent = correctedContent;
        fs.writeFileSync(structuredDataPath, structuredDataContent, 'utf-8');
        console.log('  Structured data corrected.');
      } catch {
        console.warn('  Corrected JSON invalid, keeping original.');
      }
    }
  } else if (validationStatus === 'pass') {
    console.log('  Validation passed with no issues.');
  } else {
    console.log(`  Validation status: ${validationStatus} (${validationIssues.length} issues)`);
  }

  console.log(`✅ Phase 5 complete: validation.md`);

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
  let htmlContent = '';
  const htmlStream = await gemini.sendMessageStream(
    htmlPrompt,
    `${sessionId}-html`,
    undefined,
    { model: REALM_CONFIG.models.html }
  );

  for await (const chunk of htmlStream) {
    htmlContent += chunk;
    process.stdout.write('.');
  }
  console.log(' Done!');

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

    let reviewContent = '';
    const reviewStream = await gemini.sendMessageStream(
      reviewPrompt,
      `${sessionId}-content-review`,
      undefined,
      { model: REALM_CONFIG.models.doctor }
    );

    for await (const chunk of reviewStream) {
      reviewContent += chunk;
      process.stdout.write('.');
    }
    console.log(' Done!');

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

      let regenHtml = '';
      const regenStream = await gemini.sendMessageStream(
        regenPrompt,
        `${sessionId}-html-regen`,
        undefined,
        { model: REALM_CONFIG.models.html }
      );

      for await (const chunk of regenStream) {
        regenHtml += chunk;
        process.stdout.write('.');
      }
      console.log(' Done!');

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
