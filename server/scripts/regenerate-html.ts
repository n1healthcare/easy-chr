/**
 * Regenerate HTML from existing markdown files
 *
 * Usage: npx tsx scripts/regenerate-html.ts [prompt]
 *
 * This script skips phases 1-7 and only runs phase 8 (HTML generation)
 * using the existing files in storage/
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { GeminiAdapter } from '../src/adapters/gemini/gemini.adapter.js';
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

async function regenerateHtml(userPrompt?: string) {
  const storageDir = path.join(process.cwd(), 'storage');

  // Check required files exist
  const requiredFiles = [
    'analysis.md',
    'cross_systems.md',
    'final_analysis.md',
    'structured_data.json'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(storageDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${file}. Run the full pipeline first.`);
    }
  }

  // Load all the intermediate files
  console.log('Loading intermediate files...');
  const analysisContent = fs.readFileSync(path.join(storageDir, 'analysis.md'), 'utf-8');
  const crossSystemsContent = fs.readFileSync(path.join(storageDir, 'cross_systems.md'), 'utf-8');
  const finalAnalysisContent = fs.readFileSync(path.join(storageDir, 'final_analysis.md'), 'utf-8');
  const structuredDataContent = fs.readFileSync(path.join(storageDir, 'structured_data.json'), 'utf-8');

  // Optional: research data
  let researchContent = '';
  const researchPath = path.join(storageDir, 'research.json');
  if (fs.existsSync(researchPath)) {
    researchContent = fs.readFileSync(researchPath, 'utf-8');
  }

  console.log(`Loaded:
  - analysis.md: ${analysisContent.length} chars
  - cross_systems.md: ${crossSystemsContent.length} chars
  - final_analysis.md: ${finalAnalysisContent.length} chars
  - structured_data.json: ${structuredDataContent.length} chars
  - research.json: ${researchContent.length} chars`);

  // Load HTML builder skill
  const htmlSkill = loadSkill('html-builder');
  console.log(`Loaded html-builder skill: ${htmlSkill.length} chars`);

  // Build the prompt
  const prompt = userPrompt || '';
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
</final_analysis>

${researchContent ? `### Priority 5: Research Data (for references)
<research_json>
${researchContent}
</research_json>` : ''}`;

  console.log(`\nGenerating HTML... (payload: ${Math.round(htmlPrompt.length / 1024)}KB)`);
  console.log(`Using model: ${REALM_CONFIG.models.html}`);

  // Create Gemini adapter and generate
  const gemini = new GeminiAdapter();
  await gemini.initialize();
  const sessionId = uuidv4();

  let htmlContent = '';
  const stream = await gemini.sendMessageStream(
    htmlPrompt,
    `regenerate-${sessionId}`,
    undefined,
    { model: REALM_CONFIG.models.html }
  );

  process.stdout.write('Streaming: ');
  for await (const chunk of stream) {
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

  // Save to new realm
  const realmId = uuidv4();
  const realmDir = path.join(storageDir, 'realms', realmId);
  fs.mkdirSync(realmDir, { recursive: true });

  const htmlPath = path.join(realmDir, 'index.html');
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

  console.log(`\n✅ HTML generated: ${htmlContent.length} chars`);
  console.log(`📁 Saved to: ${htmlPath}`);
  console.log(`🌐 View at: http://localhost:5173/realms/${realmId}/index.html`);
}

// Run
const userPrompt = process.argv[2] || '';
regenerateHtml(userPrompt).catch(console.error);
