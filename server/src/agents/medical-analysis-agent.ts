/**
 * Medical Analysis Agent Definition
 *
 * This agent acts as a Senior Integrative Systems Physician.
 * It analyzes extracted medical documents to produce a deep, systemic health analysis
 * using the "god-level" medical-analysis skill framework.
 */

import type { LocalAgentDefinition } from '../../vendor/gemini-cli/packages/core/src/agents/types.js';
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
} from '../../vendor/gemini-cli/packages/core/src/tools/tool-names.js';
import { REALM_CONFIG } from '../config.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// Load the SKILL.md content for the system prompt
function loadSkillContent(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'medical-analysis',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract just the content after the frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[MedicalAnalysisAgent] Could not load SKILL.md, using fallback prompt');
    return FALLBACK_SKILL_PROMPT;
  }
}

const FALLBACK_SKILL_PROMPT = `
You are a World-Class Integrative Physician. Your goal is to tell the biological story of the patient.

## Your Objectives
1. Read the extracted.md file.
2. Analyze the patient using the Functional Medicine Matrix (Antecedents, Triggers, Mediators).
3. Apply Systems Biology to connect disparate symptoms (e.g., Gut-Brain, Thyroid-Adrenal).
4. Write a "God-Level" comprehensive analysis.md report.

## Output Requirements
Write your analysis to \`analysis.md\` following the Systems Biology Framework:
- Executive Narrative (The Story)
- Red Flag Alerts
- Systems Analysis (Neuro-Adrenal, Metabolic, Immune/Gut, Detox)
- Pharmacology & Supplement Review
- Missing Data (The Blind Spots)
- The Master Protocol (Repair & Optimize)

Always use absolute file paths.
`;

/**
 * The Medical Analysis Agent definition.
 *
 * This agent:
 * 1. Reads the extracted.md file (patient medical data from OCR)
 * 2. Applies a Systems Biology & Functional Medicine lens to the data
 * 3. Writes a comprehensive "God-Level" analysis.md report
 */
export function createMedicalAnalysisAgent(
  storageDir: string
): LocalAgentDefinition {
  const skillContent = loadSkillContent();
  const extractedPath = path.join(storageDir, 'extracted.md');
  const analysisPath = path.join(storageDir, 'analysis.md');

  return {
    name: 'medical_analyst',
    kind: 'local',
    displayName: 'Integrative Systems Physician',
    description: 'A "god-level" medical AI that performs deep systemic health analysis, connecting biomarkers, lifestyle, and pharmacology into a cohesive biological narrative.',

    inputConfig: {
      inputs: {
        extractedFilePath: {
          description: 'Absolute path to the extracted.md file containing patient medical data',
          type: 'string',
          required: true,
        },
        outputFilePath: {
          description: 'Absolute path where the analysis.md report should be written',
          type: 'string',
          required: true,
        },
        userPrompt: {
          description: 'Optional user context, specific symptoms, or analysis focus',
          type: 'string',
          required: false,
        },
      },
    },

    // No structured output - agent writes to file and returns summary
    outputConfig: undefined,

    modelConfig: {
      model: REALM_CONFIG.models.doctor,
      temp: 0.2, // Low temperature for precise medical reasoning
      top_p: 0.9,
    },

    runConfig: {
      max_time_minutes: 15, // Deep analysis requires time
      max_turns: 8, // Allow for more reasoning steps if needed
    },

    toolConfig: {
      tools: [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME, EDIT_TOOL_NAME],
    },

    promptConfig: {
      query: `You are the world's most advanced Integrative Systems Physician.

**Input File:** \${extractedFilePath}
**Output File:** \${outputFilePath}

\${userPrompt ? 'User Context: ' + userPrompt : ''}

**Your Mission:**
1.  **Ingest:** Read the extracted medical data from \`extracted.md\`.
2.  **Analyze:** Apply the **7-Layer Protocol** from your system instructions. Do not just look at numbers; look for *patterns* and *relationships* (e.g., "Is the high cholesterol actually a protective mechanism against inflammation?").
3.  **Synthesize:** Write the \`analysis.md\` report. It must be a narrative of the patient's health, not just a list of stats.
4.  **Verify:** Ensure the file exists and follows the mandatory structure.

**Critical Thinking Requirement:**
Before writing, you must ask yourself: "What is the root cause?" If you see a symptom, trace it back to the System (e.g., Low Energy -> Mitochondria -> Thyroid -> Stress).

When complete, call \`complete_task\` with:
- The core "Diagnosis/Pattern" identified (1 sentence).
- The top 3 most critical "Red Flags".
- A confirmation that the Master Protocol has been generated.`,

      systemPrompt: `${skillContent}

## Operational Protocols

You are running in **Autonomous Specialist Mode**.

1.  **Pathing:** Use EXACT absolute paths provided.
2.  **Sequence:**
    *   **Step 1:** Read \`extracted.md\`.
    *   **Step 2:** (Internal Monologue) Map the data to the Functional Matrix. Identify the "Story".
    *   **Step 3:** Write \`analysis.md\`.
3.  **Tone:** Authoritative, empathetic, highly technical but accessible. Use medical terminology correctly but explain complex concepts.
4.  **Safety:** If you see imminent life-threatening values (e.g., Potassium > 6.0, Troponin elevated), flag them as **CRITICAL EMERGENCY** in the Executive Narrative.

## Today's Date
\${today}
`,
    },
  };
}
