import { LLMClientPort } from '../ports/llm-client.port.js';
import { REALM_CONFIG } from '../../config.js';
import fs from 'fs';
import path from 'path';

// ============================================================================
// Skill Loader
// ============================================================================

function loadResearcherSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'researcher',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract content after frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[ResearchSection] Could not load researcher SKILL.md, using fallback');
    return 'You are an expert Medical Researcher. Use Google Search to find authoritative medical information.';
  }
}

export class ResearchSectionUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async *execute(sectionContext: string, userQuery?: string): AsyncGenerator<string, void, unknown> {
    console.log("Researcher: Digging deeper into section...");

    const modelName = REALM_CONFIG.models.intermediate;
    const sessionId = `research-${Date.now()}`; // Unique session for each research request
    const researcherSkill = loadResearcherSkill();

    const prompt = `${researcherSkill}

---

## Your Task

**Context (From the Patient's Report):**
"${sectionContext}"

${userQuery ? `**Specific Question:** "${userQuery}"` : ''}

**Goal:** "Dig Deeper" into this topic. Use Google Search to find the latest, most authoritative medical information to explain this context to the patient.

Start directly with the content.`;

    try {
      // Use the LLMClientPort with Google Search tools
      const stream = await this.llmClient.sendMessageStream(
        prompt,
        sessionId,
        [], // No files
        {
          model: modelName,
          tools: [{ googleSearch: {} }]
        }
      );

      for await (const chunk of stream) {
        yield chunk;
      }
    } catch (error) {
      console.error("Research failed:", error);
      yield "> **Error:** Unable to complete research at this time. Please try again later.";
    }
  }
}
