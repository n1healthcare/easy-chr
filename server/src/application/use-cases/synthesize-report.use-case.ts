import { LLMClientPort } from '../ports/llm-client.port.js';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../../config.js';

export class SynthesizeReportUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async execute(realmDir: string, userPrompt: string): Promise<string> {
    console.log(`Synthesizer: Generating comprehensive report...`);

    const factsPath = path.join(realmDir, 'facts.md');
    const analysisPath = path.join(realmDir, 'analysis.md');
    const relationshipsPath = path.join(realmDir, 'relationships.md');
    const outputPath = path.join(realmDir, 'report.md');

    // Load the 3 specialist outputs
    // We assume they exist because GenerateRealmUseCase calls Specialists first
    // But we should handle missing files gracefully
    const inputs: string[] = [];
    if (fs.existsSync(factsPath)) inputs.push(factsPath);
    if (fs.existsSync(analysisPath)) inputs.push(analysisPath);
    if (fs.existsSync(relationshipsPath)) inputs.push(relationshipsPath);

    if (inputs.length === 0) {
      throw new Error("No specialist outputs found to synthesize.");
    }

    const sessionId = `synthesizer-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const systemPrompt = `
      You are the **Chief Medical Officer** and **Patient Advocate**.
      
      Based on the detailed findings from the Facts, Analysis, and Relationships specialists:
      
      Conduct a deepresearch on all the information provided by the specialist agents.
      You must have a holistic view of the patient's health data.
      You must be accurate and informative on all your findings connections, implications, and actionable insights.
      
      **User's Specific Question/Focus:** "${userPrompt}"
      (You MUST address this question directly and prominently in the Executive Summary and throughout the report).

      **Goal:** Accumulate all the specialist findings into a **Comprehensive Health Intelligence Report** for the patient. 
      Your tone should be authoritative yet empathetic, clear, and action-oriented. You are translating complex data into a "User Manual for the Body".
      Do not just summarize; synthesize BUT provide deep insight that is accurate to the data.
      
      **Core Questions to Answer:**
      1.  **"Am I well?"** (Current Status & Functional Health Grades)
      2.  **"What is the story of my health?"** (Timeline & Root Cause Analysis)
      3.  **"What should I watch out for?"** (Risk Factors, Future Projections)
      4.  **"What do I do now?"** (Actionable, Prioritized Steps)
      
      You do not need to have a fixed structure as stated below, but ensure you understand what people would want when they come to you for a comprehensive health report.

      **Report Structure:**(optional)
      
      # Health Intelligence Report
      
      ## 1. Executive Summary
      *   **The Bottom Line:** A 3-sentence summary of their overall health status.
      *   **Critical Alerts:** Immediate red flags (if any).
      
      ## 2. Functional Systems Review
      (Group findings by system, e.g., Metabolic, Cardiovascular, Hormonal. For each system, grade it: Optimal / Sub-optimal / At Risk).
      
      ## 3. The Health Timeline
      (A narrative journey explaining *how* they got here. Connect past events to current states).
      
      ## 4. Deep Dive: Analysis & Interactions
      *   **Medication & Supplement Review:** Interactions, depletions, and efficacy.
      *   **Root Cause Hypotheses:** Connecting disparate symptoms to underlying mechanisms (e.g., Inflammation, Insulin Resistance).
      
      ## 5. Future Outlook & Projections
      *   **5-Year Trajectory:** If current trends continue...
      *   **Preventative Focus:** Key areas to monitor.
      
      ## 6. Actionable Strategy
      *   **Lifestyle:** Sleep, stress, exercise modifications tailored to *their* data.
      *   **Dietary:** Specific foods to include/avoid based on biomarkers.
      *   **Questions for your Doctor:** High-level questions the patient should ask their primary care provider.
      
      **Rules:**
      *   **Citation:** Maintain all [Source: ...] citations.
      *   **Clarity:** Use bolding for key terms. Avoid purely academic jargon; explain terms like "Homocysteine" or "CRP".
      *   **No Fluff:** Be concise but comprehensive.

      **CRITICAL INSTRUCTION - THINKING PROCESS:**
      1.  First, enclose your thinking process in \`<thinking>...</thinking>\` tags.
      2.  Analyze the data deeply within these tags.
      3.  Then, output the final Markdown content immediately after the closing tag.
    `;

    const stream = await this.llmClient.sendMessageStream(
      systemPrompt,
      sessionId,
      inputs,
      { model: REALM_CONFIG.models.intermediate } // Using INTERMEDIATE_MODEL as requested
    );

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk;
    }

    // Parse XML thinking tags
    let finalContent = fullResponse;
    const thinkingMatch = fullResponse.match(/<thinking>([\s\S]*?)<\/thinking>/);
    
    if (thinkingMatch) {
      const thought = thinkingMatch[1].trim();
      console.log(`[Synthesizer Thinking]: ${thought.substring(0, 200)}...`);
      
      // Remove thinking tags and content to get the clean report
      finalContent = fullResponse.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
    }

    fs.writeFileSync(outputPath, finalContent);
    console.log(`Synthesizer: Saved master report to ${outputPath}`);
    
    return outputPath;
  }
}
