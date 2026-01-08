import { GoogleGenAI } from '@google/genai';
import { REALM_CONFIG } from '../../config.js';

export class ResearchSectionUseCase {
  private client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.client = new GoogleGenAI({ apiKey: apiKey });
  }

  async *execute(sectionContext: string, userQuery?: string): AsyncGenerator<string, void, unknown> {
    console.log("Researcher: Digging deeper into section...");

    const modelName = REALM_CONFIG.models.intermediate;
    
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
      // Using the new @google/genai SDK pattern
      const responseStream = await this.client.models.generateContentStream({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          yield text;
        }
      }
    } catch (error) {
      console.error("Research failed:", error);
      yield "> **Error:** Unable to complete research at this time. Please try again later.";
    }
  }
}
