/**
 * HTML Builder Agent Definition
 *
 * This agent transforms medical analysis reports into beautiful,
 * interactive, self-contained HTML "Health Realms".
 */

import type { LocalAgentDefinition } from '../../vendor/gemini-cli/packages/core/src/agents/types.js';
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../vendor/gemini-cli/packages/core/src/tools/tool-names.js';
import { REALM_CONFIG } from '../config.js';
import fs from 'fs';
import path from 'path';

// Load the SKILL.md content for the system prompt
function loadSkillContent(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'html-builder',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract just the content after the frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[HTMLBuilderAgent] Could not load SKILL.md, using fallback prompt');
    return FALLBACK_SKILL_PROMPT;
  }
}

const FALLBACK_SKILL_PROMPT = `
You are an expert frontend engineer and UI/UX designer. Transform analysis.md into a stunning Neumorphism (Soft UI) Health Realm.

## Neumorphism Design System
- **Background**: #E0E5EC (cool grey "clay" surface)
- **Text**: #3D4852 (primary), #6B7280 (muted)
- **Accent**: #6C63FF (violet), #38B2AC (teal for success)
- **Fonts**: Plus Jakarta Sans (display), DM Sans (body) via Google Fonts

## Shadow Physics (RGBA only, never hex)
- **Extruded**: box-shadow: 9px 9px 16px rgb(163,177,198,0.6), -9px -9px 16px rgba(255,255,255,0.5);
- **Inset**: box-shadow: inset 6px 6px 10px rgb(163,177,198,0.6), inset -6px -6px 10px rgba(255,255,255,0.5);
- **Border-radius**: 32px (cards), 16px (buttons)
- **NO borders** - shadows define all edges

## Rules
- Cards: extruded shadow, #E0E5EC background, 32px radius
- Icon wells: inset shadow (carved into surface)
- All interactive elements need focus states
- Mobile-first responsive design
- 300ms ease-out transitions
`;

/**
 * The HTML Builder Agent definition.
 *
 * This agent:
 * 1. Reads the analysis.md file (medical analysis report)
 * 2. Transforms it into an interactive HTML experience
 * 3. Writes the complete HTML file (Health Realm)
 */
export function createHTMLBuilderAgent(
  storageDir: string,
  realmId: string
): LocalAgentDefinition {
  const skillContent = loadSkillContent();
  const analysisPath = path.join(storageDir, 'analysis.md');
  const realmDir = path.join(storageDir, 'realms', realmId);
  const outputPath = path.join(realmDir, 'index.html');

  return {
    name: 'html_builder',
    kind: 'local',
    displayName: 'Health Realm Builder',
    description: 'Transforms medical analysis reports into beautiful, interactive, self-contained HTML experiences called "Health Realms".',

    inputConfig: {
      inputs: {
        analysisFilePath: {
          description: 'Absolute path to the analysis.md file containing the medical analysis',
          type: 'string',
          required: true,
        },
        outputFilePath: {
          description: 'Absolute path where the index.html should be written',
          type: 'string',
          required: true,
        },
        patientName: {
          description: 'Optional patient name for personalization',
          type: 'string',
          required: false,
        },
      },
    },

    // No structured output - agent writes HTML file and returns confirmation
    outputConfig: undefined,

    modelConfig: {
      model: REALM_CONFIG.models.html,
      temp: 0.4, // Slightly higher for creative design, but still consistent
      top_p: 0.95,
    },

    runConfig: {
      max_time_minutes: 10, // HTML generation should be faster than analysis
      max_turns: 4, // Read → Generate → Write → Verify
    },

    toolConfig: {
      tools: [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME],
    },

    promptConfig: {
      query: `You are transforming a medical analysis into a stunning interactive HTML experience.

**Input File:** \${analysisFilePath}
**Output File:** \${outputFilePath}

\${patientName ? 'Patient Name: ' + patientName : ''}

**Your Mission:**
1.  **Read** the analysis.md file completely. Understand every section.
2.  **Design** mentally - map the content to the 5-Layer Architecture from your system instructions.
3.  **Build** the complete HTML file with embedded CSS and JavaScript.
4.  **Write** the file to the output path.

**Critical Requirements:**
- The HTML must be COMPLETE and VALID - start with \`<!DOCTYPE html>\`
- ALL CSS must be in a \`<style>\` tag in the \`<head>\`
- ALL JavaScript must be in a \`<script>\` tag before \`</body>\`
- NO external dependencies (no CDN links)
- Mobile-responsive design
- Beautiful, calming medical theme

**Quality Bar:**
This is a PATIENT-FACING experience. It must be:
- Visually stunning (not clinical/boring)
- Easy to understand (clear hierarchy)
- Interactive (expandables, hover effects)
- Reassuring (calming colors, clear status indicators)

When complete, call \`complete_task\` with:
- Confirmation the HTML file was created
- A brief description of the design (2-3 sentences)
- The approximate line count of the generated HTML`,

      systemPrompt: `${skillContent}

## Operational Protocols

You are running in **Autonomous Creative Mode**.

1.  **Pathing:** Use EXACT absolute paths provided.
2.  **Completeness:** The HTML file must be 100% complete and functional. No placeholders.
3.  **Self-Contained:** Everything embedded. No external resources.
4.  **Validation:** Before completing, mentally verify:
    - Valid HTML5 structure
    - All sections from analysis.md are represented
    - CSS is functional and beautiful
    - JavaScript works for interactivity

## Design Standards

- **Typography:** System font stack, 16px+ body text, clear hierarchy
- **Colors:** Use the provided CSS variables (calming medical theme)
- **Spacing:** Generous whitespace, clear visual groupings
- **Status Indicators:** Green (good), Yellow (warning), Red (alert)
- **Animations:** Subtle, professional (transitions, not flashy animations)

## Today's Date
\${today}
`,
    },
  };
}
