/**
 * Regenerate Analysis from existing extracted.md
 *
 * Usage: npx tsx scripts/regenerate-analysis.ts [prompt]
 *
 * This script skips phase 1 (extraction) and runs phases 2-8:
 * - Phase 2: Medical Analysis
 * - Phase 3: Cross-System Analysis
 * - Phase 4: Research
 * - Phase 5: Synthesis
 * - Phase 6: Validation
 * - Phase 7: Data Structuring
 * - Phase 8: HTML Generation
 *
 * Uses existing extracted.md from storage/
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GeminiAdapter } from '../src/adapters/gemini/gemini.adapter.js';
import { AgenticMedicalAnalyst } from '../src/services/agentic-medical-analyst.service.js';
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
  // Phase 3: Cross-System Analysis
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 3: Cross-System Analysis');
  console.log('='.repeat(60));

  const crossSystemsPath = path.join(storageDir, 'cross_systems.md');
  let crossSystemsContent = '';

  const crossSystemSkill = loadSkill('cross-system-analyst');
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

  console.log('Analyzing cross-system connections...');
  const crossSystemStream = await gemini.sendMessageStream(
    crossSystemPrompt,
    `${sessionId}-crosssystem`,
    undefined,
    { model: REALM_CONFIG.models.doctor }
  );

  for await (const chunk of crossSystemStream) {
    crossSystemsContent += chunk;
    process.stdout.write('.');
  }
  console.log(' Done!');

  crossSystemsContent = stripThinkingText(crossSystemsContent, /^#\s+.+$/m);
  fs.writeFileSync(crossSystemsPath, crossSystemsContent, 'utf-8');
  console.log(`✅ Phase 3 complete: cross_systems.md (${crossSystemsContent.length} chars)`);

  // ========================================================================
  // Phase 4: Research
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 4: Research');
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
      crossSystemsContent,
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
    console.log(`✅ Phase 4 complete: research.json (${researchOutput.researchedClaims.length} claims)`);
  } else {
    console.log('⚠️ Gemini config not available, skipping research phase');
  }

  // ========================================================================
  // Phase 5: Synthesis
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 5: Synthesis');
  console.log('='.repeat(60));

  const finalAnalysisPath = path.join(storageDir, 'final_analysis.md');
  let finalAnalysisContent = '';

  const synthesizerSkill = loadSkill('synthesizer');
  const researchSection = researchOutput.researchedClaims.length > 0
    ? `\n\n### Research Findings (Verified Claims with Citations)\n<research>\n${researchMarkdown}\n</research>`
    : '';

  const synthesisPrompt = `${synthesizerSkill}

---

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
</cross_systems>${researchSection}`;

  console.log('Synthesizing final analysis...');
  const synthesisStream = await gemini.sendMessageStream(
    synthesisPrompt,
    `${sessionId}-synthesis`,
    undefined,
    { model: REALM_CONFIG.models.doctor }
  );

  for await (const chunk of synthesisStream) {
    finalAnalysisContent += chunk;
    process.stdout.write('.');
  }
  console.log(' Done!');

  finalAnalysisContent = stripThinkingText(finalAnalysisContent, /^#\s+.+$/m);
  fs.writeFileSync(finalAnalysisPath, finalAnalysisContent, 'utf-8');
  console.log(`✅ Phase 5 complete: final_analysis.md (${finalAnalysisContent.length} chars)`);

  // ========================================================================
  // Phase 6: Validation
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 6: Validation');
  console.log('='.repeat(60));

  const validationPath = path.join(storageDir, 'validation.md');
  const MAX_CORRECTION_CYCLES = 1;
  let correctionCycle = 0;
  let validationPassed = false;

  while (correctionCycle <= MAX_CORRECTION_CYCLES && !validationPassed) {
    const validatorSkill = loadSkill('validator');
    const validationPrompt = `${validatorSkill}

---

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Original Extracted Data (Source of Truth)
<extracted_data>
${allExtractedContent}
</extracted_data>

### Final Synthesized Analysis (To Validate)
<final_analysis>
${finalAnalysisContent}
</final_analysis>`;

    console.log(`Validating analysis (cycle ${correctionCycle})...`);
    let validationContent = '';
    const validationStream = await gemini.sendMessageStream(
      validationPrompt,
      `${sessionId}-validation-${correctionCycle}`,
      undefined,
      { model: REALM_CONFIG.models.doctor }
    );

    for await (const chunk of validationStream) {
      validationContent += chunk;
      process.stdout.write('.');
    }
    console.log(' Done!');

    validationContent = stripThinkingText(validationContent, /^#\s+.+$/m);
    fs.writeFileSync(validationPath, validationContent, 'utf-8');

    const needsRevision = validationContent.toLowerCase().includes('needs revision');
    const hasCriticalErrors = (validationContent.match(/❌/g) || []).length > 0;

    if (needsRevision || hasCriticalErrors) {
      console.log('  Validation found issues.');
      if (correctionCycle < MAX_CORRECTION_CYCLES) {
        console.log('  Sending corrections back to synthesizer...');

        const correctionsMatch = validationContent.match(/## Required Corrections[\s\S]*?(?=##|$)/);
        const requiredCorrections = correctionsMatch ? correctionsMatch[0] : '';

        const correctionPrompt = `${synthesizerSkill}

---

## CORRECTION TASK

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

${requiredCorrections ? `### Required Corrections (MUST FIX)\n${requiredCorrections}` : ''}`;

        let correctedContent = '';
        const correctionStream = await gemini.sendMessageStream(
          correctionPrompt,
          `${sessionId}-correction-${correctionCycle}`,
          undefined,
          { model: REALM_CONFIG.models.doctor }
        );

        for await (const chunk of correctionStream) {
          correctedContent += chunk;
        }

        if (correctedContent.trim().length > 0) {
          correctedContent = stripThinkingText(correctedContent, /^#\s+.+$/m);
          finalAnalysisContent = correctedContent;
          fs.writeFileSync(finalAnalysisPath, finalAnalysisContent, 'utf-8');
          console.log('  Synthesis corrected. Re-validating...');
        } else {
          validationPassed = true;
        }
        correctionCycle++;
      } else {
        console.log('  Max correction cycles reached. Proceeding.');
        validationPassed = true;
      }
    } else {
      console.log('  Validation passed.');
      validationPassed = true;
    }
  }

  console.log(`✅ Phase 6 complete: validation.md`);

  // ========================================================================
  // Phase 7: Data Structuring
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 7: Data Structuring');
  console.log('='.repeat(60));

  const structuredDataPath = path.join(storageDir, 'structured_data.json');
  let structuredDataContent = '';

  const dataStructurerSkill = loadSkill('data-structurer');
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

### Priority 3: Final Synthesized Analysis (for patient-facing narrative)
<final_analysis>
${finalAnalysisContent}
</final_analysis>

### Priority 4: Original Extracted Data (source of truth for raw values)
<extracted_data>
${allExtractedContent}
</extracted_data>`;

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
  structuredDataContent = structuredDataContent.trim();
  const jsonStartIndex = structuredDataContent.indexOf('{');
  if (jsonStartIndex > 0) {
    structuredDataContent = structuredDataContent.slice(jsonStartIndex);
  }
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
  console.log(`✅ Phase 7 complete: structured_data.json (${structuredDataContent.length} chars)`);

  // ========================================================================
  // Phase 8: HTML Generation
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 8: HTML Generation');
  console.log('='.repeat(60));

  const realmId = uuidv4();
  const realmDir = path.join(storageDir, 'realms', realmId);
  fs.mkdirSync(realmDir, { recursive: true });

  const htmlSkill = loadSkill('html-builder');
  const htmlPrompt = `${htmlSkill}

---

${prompt ? `### Patient's Question/Context\n${prompt}\n\n` : ''}### Priority 1: Structured Data (for charts and visualizations)
<structured_data>
${structuredDataContent}
</structured_data>

### Priority 2: Rich Medical Analysis (for detailed sections)
<analysis>
${analysisContent}
</analysis>

### Priority 3: Cross-System Analysis (for mechanism explanations)
<cross_systems>
${crossSystemsContent}
</cross_systems>

### Priority 4: Final Synthesized Analysis (for patient-facing narrative)
<final_analysis>
${finalAnalysisContent}
</final_analysis>`;

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

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ All phases complete!');
  console.log(`${'='.repeat(60)}`);
  console.log(`📁 HTML saved to: ${htmlPath}`);
  console.log(`🌐 View at: http://localhost:5173/realms/${realmId}/index.html`);
}

// Run
const userPrompt = process.argv[2] || '';
regenerateAnalysis(userPrompt).catch(console.error);
