/**
 * Regenerate HTML from existing structured data
 *
 * Usage: npx tsx scripts/regenerate-html.ts [prompt]
 *
 * This script skips phases 1-5 and runs phases 6-8:
 * - Phase 6: HTML Generation (from structured_data.json)
 * - Phase 7: Content Review (compares structured_data.json vs index.html)
 * - Phase 8: HTML Regeneration (if gaps found)
 *
 * Uses existing files in storage/
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

async function regenerateHtml(userPrompt?: string) {
  const storageDir = path.join(process.cwd(), 'storage');

  // Check required files exist
  const requiredFiles = [
    'structured_data.json'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(storageDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${file}. Run the full pipeline first.`);
    }
  }

  // Load structured data (the only required file)
  console.log('Loading structured data...');
  const structuredDataContent = fs.readFileSync(path.join(storageDir, 'structured_data.json'), 'utf-8');

  console.log(`Loaded:
  - structured_data.json: ${structuredDataContent.length} chars`);

  // Load HTML builder skill
  const htmlSkill = loadSkill('html-builder');
  console.log(`Loaded html-builder skill: ${htmlSkill.length} chars`);

  // Build the prompt - DATA-DRIVEN: only structured_data.json
  const prompt = userPrompt || '';
  const htmlPrompt = `${htmlSkill}

---

### Structured Data (SOURCE OF TRUTH)
This JSON contains ALL data for rendering. Iterate through each field and render appropriate sections.
Only render sections for fields that have data. Do not invent sections not in this JSON.
<structured_data>
${structuredDataContent}
</structured_data>`;

  console.log(`\nGenerating HTML... (payload: ${Math.round(htmlPrompt.length / 1024)}KB)`);
  console.log(`Using model: ${REALM_CONFIG.models.html}`);

  // Create Gemini adapter and generate
  const gemini = new GeminiAdapter();
  await gemini.initialize();
  const sessionId = uuidv4();

  let htmlContent = await streamWithRetry(gemini, htmlPrompt, `regenerate-${sessionId}`, REALM_CONFIG.models.html, 'HTMLGeneration');

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

  console.log(`\n✅ Phase 6 complete: index.html (${htmlContent.length} chars)`);

  // ========================================================================
  // Phase 7: Content Review
  // Compares structured_data.json against index.html to identify information loss
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('Phase 7: Content Review');
  console.log('='.repeat(60));
  console.log('Comparing structured_data.json against generated HTML...');
  console.log('Checking for: all JSON fields rendered, specifics preserved, visual design quality');

  const contentReviewPath = path.join(storageDir, 'content_review.json');
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
      fs.writeFileSync(contentReviewPath, JSON.stringify(contentReviewResult, null, 2), 'utf-8');
      console.log(`  Content review: passed=${contentReviewResult.overall.passed}, action=${contentReviewResult.overall.action}`);
    } catch {
      console.warn('  Content review JSON parse failed, assuming pass');
      contentReviewResult = { overall: { passed: true, summary: '', action: 'pass' } };
    }

    if (contentReviewResult.overall.passed) {
      console.log('  ✅ Content review passed - all four dimensions acceptable.');
    } else {
      console.log('  ⚠️ Content review found issues:');

      // Dimension 0: User Question Addressed (MOST IMPORTANT)
      if (contentReviewResult.user_question_addressed) {
        const uq = contentReviewResult.user_question_addressed;
        if (!uq.passed) {
          console.log(`  [User Question] FAILED - Question not properly addressed`);
          if (!uq.question_answered) console.log('     - Question not directly answered');
          if (!uq.answer_prominent) console.log('     - Answer not prominent/visible');
          if (!uq.findings_connected) console.log('     - Findings not connected to question');
        } else {
          console.log('  [User Question] Passed - Question addressed prominently');
        }
      }

      // Dimension 1: Detail Fidelity
      if (contentReviewResult.detail_fidelity) {
        const df = contentReviewResult.detail_fidelity;
        if (!df.passed) {
          const highCount = df.issues.filter(i => i.severity === 'high').length;
          const mediumCount = df.issues.filter(i => i.severity === 'medium').length;
          console.log(`  [Detail Fidelity] FAILED - ${df.issues.length} issue(s): ${highCount} high, ${mediumCount} medium`);
        } else {
          console.log('  [Detail Fidelity] Passed');
        }
      }

      // Dimension 2: Content Completeness
      if (contentReviewResult.content_completeness) {
        const cc = contentReviewResult.content_completeness;
        if (!cc.passed) {
          console.log(`  [Content Completeness] FAILED - Missing categories: ${cc.missing_categories.map(c => c.category).join(', ')}`);
        } else {
          console.log(`  [Content Completeness] Passed - Present: ${cc.present_categories.join(', ')}`);
        }
      }

      // Dimension 3: Visual Design
      if (contentReviewResult.visual_design) {
        const vd = contentReviewResult.visual_design;
        console.log(`  [Visual Design] Score: ${vd.score.toUpperCase()}`);
        if (vd.weaknesses.length > 0) {
          console.log(`     Weaknesses: ${vd.weaknesses.slice(0, 3).join('; ')}`);
        }
      }

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
  // If content review found issues, regenerate HTML with feedback
  // ========================================================================
  if (contentReviewResult.overall.action === 'regenerate_with_feedback' && contentReviewResult.overall.feedback_for_regeneration) {
    console.log('\n' + '='.repeat(60));
    console.log('Phase 8: HTML Regeneration');
    console.log('='.repeat(60));
    console.log('Regenerating HTML with reviewer feedback...');
    console.log(`Feedback: ${contentReviewResult.overall.feedback_for_regeneration!.substring(0, 200)}...`);

    try {
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

      console.log(`Regenerating HTML... (payload: ${Math.round(regenPrompt.length / 1024)}KB)`);

      let regenHtml = await streamWithRetry(gemini, regenPrompt, `${sessionId}-html-regen`, REALM_CONFIG.models.html, 'HTMLRegeneration');

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
          fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
          console.log(`  ✅ HTML regenerated with fixes: ${htmlContent.length} chars`);
        } else {
          console.log('  ⚠️ Regeneration produced invalid HTML, keeping original.');
        }
      } else {
        console.log('  ⚠️ Regeneration returned empty, keeping original HTML.');
      }

      console.log(`✅ Phase 8 complete`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  HTML regeneration failed: ${errorMessage}`);
      console.log('  Using original HTML.');
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
regenerateHtml(userPrompt).catch(console.error);
