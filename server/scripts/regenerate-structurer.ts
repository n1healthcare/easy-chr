/**
 * Regenerate Structured Data from existing analysis files
 *
 * Usage: npx tsx scripts/regenerate-structurer.ts [prompt]
 *
 * This script skips phases 1-4 and runs phases 5-7:
 * - Phase 5: Data Structuring (SOURCE OF TRUTH)
 * - Phase 6: Validation (validates structured_data.json)
 * - Phase 7: HTML Generation (from structured_data.json)
 *
 * Uses existing files from storage/:
 * - extracted.md
 * - analysis.md
 * - cross_systems.md
 * - research.json (optional)
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GeminiAdapter } from '../src/adapters/gemini/gemini.adapter.js';
import { formatResearchAsMarkdown, type ResearchOutput } from '../src/services/research-agent.service.js';
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
      console.log(`[RegenStructurer] Stripping ${index} chars of thinking text`);
      return content.slice(index);
    }
  } else {
    const match = content.match(marker);
    if (match && match.index && match.index > 0) {
      console.log(`[RegenStructurer] Stripping ${match.index} chars of thinking text`);
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

async function regenerateStructurer(userPrompt?: string) {
  const storageDir = path.join(process.cwd(), 'storage');
  const sessionId = uuidv4();
  const prompt = userPrompt || '';

  // Check required files exist
  const requiredFiles = ['extracted.md', 'analysis.md', 'cross_systems.md'];
  for (const file of requiredFiles) {
    const filePath = path.join(storageDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${file}. Run the full pipeline or regen-analysis first.`);
    }
  }

  // Load existing files
  console.log('Loading existing files...');
  const allExtractedContent = fs.readFileSync(path.join(storageDir, 'extracted.md'), 'utf-8');
  const analysisContent = fs.readFileSync(path.join(storageDir, 'analysis.md'), 'utf-8');
  const crossSystemsContent = fs.readFileSync(path.join(storageDir, 'cross_systems.md'), 'utf-8');

  // Optional: research data
  let researchOutput: ResearchOutput = { researchedClaims: [], unsupportedClaims: [], additionalFindings: [] };
  let researchMarkdown = '';
  const researchPath = path.join(storageDir, 'research.json');
  if (fs.existsSync(researchPath)) {
    const researchContent = fs.readFileSync(researchPath, 'utf-8');
    researchOutput = JSON.parse(researchContent);
    researchMarkdown = formatResearchAsMarkdown(researchOutput);
  }

  console.log(`Loaded:
  - extracted.md: ${allExtractedContent.length} chars
  - analysis.md: ${analysisContent.length} chars
  - cross_systems.md: ${crossSystemsContent.length} chars
  - research.json: ${researchOutput.researchedClaims.length} claims`);

  // Initialize Gemini adapter
  const gemini = new GeminiAdapter();
  await gemini.initialize();

  // ========================================================================
  // Phase 5: Data Structuring (SOURCE OF TRUTH)
  // Extracts chart-ready JSON
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 5: Data Structuring');
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

### Priority 3: Research Findings (for citations and verified claims)
<research>
${researchMarkdown}
</research>

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
  console.log(`✅ Phase 5 complete: structured_data.json (${structuredDataContent.length} chars)`);

  // ========================================================================
  // Phase 6: Validation
  // Validates structured_data.json completeness against source data
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

    console.log(`Validating structured data (cycle ${correctionCycle})...`);
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
        console.log('  Sending corrections back to data structurer...');

        const correctionsMatch = validationContent.match(/## Required Corrections[\s\S]*?(?=##|$)/);
        const requiredCorrections = correctionsMatch ? correctionsMatch[0] : '';

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
          correctedContent = cleanupJson(correctedContent);
          try {
            JSON.parse(correctedContent);
            structuredDataContent = correctedContent;
            fs.writeFileSync(structuredDataPath, structuredDataContent, 'utf-8');
            console.log('  Structured data corrected. Re-validating...');
          } catch {
            console.warn('  Corrected JSON invalid, keeping original.');
            validationPassed = true;
          }
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
  // Phase 7: HTML Generation
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 7: HTML Generation');
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

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ All phases complete!');
  console.log(`${'='.repeat(60)}`);
  console.log(`📁 HTML saved to: ${htmlPath}`);
  console.log(`🌐 View at: http://localhost:5173/realms/${realmId}/index.html`);
}

// Run
const userPrompt = process.argv[2] || '';
regenerateStructurer(userPrompt).catch(console.error);
