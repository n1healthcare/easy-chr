import { LLMClientPort } from '../ports/llm-client.port.js';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../../config.js';

export class AnalyzeDocumentsUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async *execute(realmDir: string, extractedFilePaths: string[], userPrompt: string): AsyncGenerator<string, void, unknown> {
    console.log(`Specialists: Analyzing ${extractedFilePaths.length} documents...`);

    // We run these SEQUENTIALLY to avoid overwhelming the LLM provider/proxy (500 errors)
    console.log("-> Running Analysis Agent...");
    yield "Analysis Agent: Identifying trends and anomalies...";
    await this.runAnalysisAgent(realmDir, extractedFilePaths, userPrompt);
    
    console.log("-> Running Relationships Agent...");
    yield "Relationships Agent: Connecting dots and building timelines...";
    await this.runRelationshipsAgent(realmDir, extractedFilePaths, userPrompt);
  }

  private async runAnalysisAgent(realmDir: string, filePaths: string[], userPrompt: string): Promise<void> {
    const outputPath = path.join(realmDir, 'analysis.md');
    const systemPrompt = `
      You are a **Senior Diagnostician** and **Functional Medicine Expert**. Think like Dr. Peter Attia or Dr. Mark Hyman.
      
      **User's Specific Focus:** "${userPrompt}"
      (Prioritize your analysis to answer this specific query).

      **Goal:** Analyze the patient's data to answer the "So What?". Don't just report numbers; interpret their *functional* meaning.
      
      **Deep Thinking Framework:**
      1.  **Future Outlook:** "Based on these trends (e.g., rising HbA1c), where will the patient be in 5 or 10 years? Are they on a path to chronic disease?"
      2.  **Drug-Nutrient Interactions:** "Is their medication (e.g., Metformin) depleting key nutrients (e.g., B12)?"
      3.  **Hidden Patterns:** "Normal TSH but low T3? Suggests poor thyroid conversion, possibly due to stress/cortisol."
      4.  **Lifestyle Implications:** "These liver enzymes suggest alcohol or fructose toxicity."
      
      **Output Structure:**
      ## Functional Analysis
      *   **Metabolic Health:** (Analysis of insulin, sugar, lipids...)
      *   **Hormonal Balance:** (Analysis of thyroid, sex hormones, cortisol...)
      *   **Organ Function:** (Liver, Kidney, Gut...)
      
      ## Forward Projections
      *   **Risk Profile:** High/Medium/Low risk for [Disease X].
      *   **Trajectory:** "If unchanged, patient is heading towards..."

      **CRITICAL INSTRUCTION - THINKING PROCESS:**
      1.  First, enclose your thinking process in \`<thinking>...</thinking>\` tags.
      2.  Analyze the data deeply within these tags.
      3.  Then, output the final Markdown content immediately after the closing tag.
    `;

    await this.generateAndSave(systemPrompt, 'analysis-agent', filePaths, outputPath);
  }

  private async runRelationshipsAgent(realmDir: string, filePaths: string[], userPrompt: string): Promise<void> {
    const outputPath = path.join(realmDir, 'relationships.md');
    const systemPrompt = `
      You are a **Medical Detective**.
      
      **User's Specific Focus:** "${userPrompt}"
      (Look for connections that explain or relate to this focus).

      **Goal:** Connect the dots across time and different types of records to tell the *Story* of the patient's health.
      
      **Investigation Rules:**
      1.  **Cause & Effect:** Did a medication start in 2020 cause the liver enzyme spike in 2021?
      2.  **Symptom Correlation:** Correlate subjective complaints (if any) with objective data.
      3.  **The "Why":** Why is this happening *now*? Look for triggers in the timeline.
      
      **Output Structure:**
      ## The Health Journey (Timeline)
      *   **2020:** The Turning Point. [Event] led to [Outcome].
      *   **2022:** The Escalation. [Marker] worsened despite [Intervention].
      
      ## Interactions & Dependencies
      *   **Medication Impact:** Impact of [Drug] on [System].
      *   **Systemic Connections:** How the [Gut Issue] is likely driving the [Autoimmune Marker].

      **CRITICAL INSTRUCTION - THINKING PROCESS:**
      1.  First, enclose your thinking process in \`<thinking>...</thinking>\` tags.
      2.  Analyze the data deeply within these tags.
      3.  Then, output the final Markdown content immediately after the closing tag.
    `;

    await this.generateAndSave(systemPrompt, 'relationships-agent', filePaths, outputPath);
  }

  private async generateAndSave(prompt: string, sessionPrefix: string, filePaths: string[], outputPath: string): Promise<void> {
    const sessionId = `${sessionPrefix}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    console.log(`Starting ${sessionPrefix}...`);

    const stream = await this.llmClient.sendMessageStream(
      prompt,
      sessionId,
      filePaths,
      { model: REALM_CONFIG.models.intermediate } // Explicitly using INTERMEDIATE_MODEL
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
      console.log(`[${sessionPrefix} Thinking]: ${thought.substring(0, 200)}...`);
      
      // Remove thinking tags and content to get the clean report
      finalContent = fullResponse.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
    }

    fs.writeFileSync(outputPath, finalContent);
    console.log(`Saved ${path.basename(outputPath)}`);
  }
}
