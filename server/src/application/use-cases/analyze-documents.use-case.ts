import { LLMClientPort } from '../ports/llm-client.port.js';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../../config.js';

export class AnalyzeDocumentsUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async *execute(realmDir: string, extractedFilePaths: string[], userPrompt: string): AsyncGenerator<string, void, unknown> {
    console.log(`Specialists: Analyzing ${extractedFilePaths.length} documents...`);

    // We run these SEQUENTIALLY to avoid overwhelming the LLM provider/proxy (500 errors)
    console.log("-> Running Facts Agent...");
    yield "Facts Agent: Extracting hard numbers and metrics...";
    await this.runFactsAgent(realmDir, extractedFilePaths, userPrompt);
    
    console.log("-> Running Analysis Agent...");
    yield "Analysis Agent: Identifying trends and anomalies...";
    await this.runAnalysisAgent(realmDir, extractedFilePaths, userPrompt);
    
    console.log("-> Running Relationships Agent...");
    yield "Relationships Agent: Connecting dots and building timelines...";
    await this.runRelationshipsAgent(realmDir, extractedFilePaths, userPrompt);
  }

  private async runFactsAgent(realmDir: string, filePaths: string[], userPrompt: string): Promise<void> {
    const outputPath = path.join(realmDir, 'facts.md');
    const systemPrompt = `
      You are a **Clinical Data Auditor** working for a top-tier Functional Medicine clinic.
      
      **User's Specific Focus:** "${userPrompt}"
      (Pay extra attention to data points relevant to this focus).

      **Goal:** Meticulously extract all clinical data points to build a "Patient Truth" database. We cannot afford to miss a single biomarker, date, or medication.
      
      **Extraction Rules:**
      1.  **Biomarkers:** Extract Value, Unit, AND Reference Range if available. (e.g., "HbA1c: 5.7% (Ref: <5.7%)").
      2.  **Context:** Note if the patient was fasting, non-fasting, stressed, or post-operative during the test.
      3.  **Citations:** Every fact must link back to its source file: \`[Source: Filename.pdf]\`.
      4.  **Medications/Supplements:** List usage, dosage, and frequency.
      5.  **Dates:** Standardize all dates to ISO 8601 (YYYY-MM-DD).
      
      **Output Structure:**
      ## Biomarkers (Categorized by Lipid, Metabolic, Hormone, etc.)
      - [Date] LDL Cholesterol: 130 mg/dL (High) [Source: ...]
      
      ## Medications & History
      - [Date] Started Atorvastatin 10mg [Source: ...]

      **CRITICAL INSTRUCTION - THINKING PROCESS:**
      1.  First, THINK about the extraction strategy and identify potential data gaps.
      2.  When you are ready to output the final Markdown, you MUST output the separator: \`---END_OF_THOUGHT---\`.
      3.  Everything AFTER that separator will be saved as the final file.
    `;

    await this.generateAndSave(systemPrompt, 'facts-agent', filePaths, outputPath);
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
      1.  First, THINK deeply about the patterns, correlations, and future implications.
      2.  When you are ready to output the final Markdown, you MUST output the separator: \`---END_OF_THOUGHT---\`.
      3.  Everything AFTER that separator will be saved as the final file.
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
      1.  First, THINK about the timeline, cause-and-effect relationships, and hidden triggers.
      2.  When you are ready to output the final Markdown, you MUST output the separator: \`---END_OF_THOUGHT---\`.
      3.  Everything AFTER that separator will be saved as the final file.
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

    // Split thinking from content
    let finalContent = fullResponse;
    if (fullResponse.includes('---END_OF_THOUGHT---')) {
      const parts = fullResponse.split('---END_OF_THOUGHT---');
      if (parts.length > 1) {
        finalContent = parts[1].trim();
        console.log(`[${sessionPrefix} Thinking]: ${parts[0].substring(0, 200)}...`);
      }
    }

    fs.writeFileSync(outputPath, finalContent);
    console.log(`Saved ${path.basename(outputPath)}`);
  }
}
