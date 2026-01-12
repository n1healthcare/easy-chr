import { LLMClientPort } from '../ports/llm-client.port.js';
import { REALM_CONFIG } from '../../config.js';

export class ResearchSectionUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async *execute(sectionContext: string, userQuery?: string): AsyncGenerator<string, void, unknown> {
    console.log("Researcher: Digging deeper into section...");

    const modelName = REALM_CONFIG.models.intermediate;
    const sessionId = `research-${Date.now()}`; // Unique session for each research request

    const prompt = `
      You are an expert Medical Researcher and Patient Advocate.

      **Context (From the Patient's Report):**
      "${sectionContext}"

      ${userQuery ? `**Specific Question:** "${userQuery}"` : ''}

      **Goal:** "Dig Deeper" into this topic. Use Google Search to find the latest, most authoritative medical information to explain this context to the patient.

      **Research Guidelines:**
      1.  **Grounding:** You MUST use Google Search to verify facts.
      2.  **Explain the "Why":** Why is this marker high? What is the mechanism?
      3.  **Actionable Context:** What are standard interventions? (Do not give medical advice, but standard-of-care info).
      4.  **Compare:** How does this patient's data compare to general population averages?

      **Output Format:**
      Return a clean **Markdown** response.
      *   Use **Bold** for key concepts.
      *   Use > Blockquotes for key study findings.
      *   Cite sources inline if possible.
      *   **Do not** repeat the input text. Add *new* value.

      Start directly with the content.
    `;

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
