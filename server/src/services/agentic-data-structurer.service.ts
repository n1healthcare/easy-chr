/**
 * Agentic Data Structurer Service
 *
 * Replaces the single-shot Phase 4 LLM call with an agentic loop.
 * The structurer builds structured_data.json section-by-section, with
 * tool-based access to the full extracted source for cross-checking values.
 *
 * Why agentic:
 * - Single-shot call received only a 50KB lab subset (extractLabSections cap)
 * - Structurer was blind to older records, narrative sections, full date ranges
 * - Agentic approach lets it query the full 1.6MB source selectively via tools
 * - Chat compression handles history growth across iterations
 *
 * Design:
 * - analysisContent + researchMarkdown are passed inline in the system prompt
 *   (they're the primary sources, manageable size, no tool needed)
 * - allExtractedContent is accessed via tools (too large for a single prompt)
 * - currentJson Map is external state — never lost during compression
 */

import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../config.js';
import { retryLLM, sleep } from '../common/index.js';
import {
  createGoogleGenAI,
  type BillingContext,
} from '../utils/genai-factory.js';
import { ChatCompressionService } from './chat-compression.service.js';
import {
  parseExtractedData,
  extractDatesFromText,
} from './agentic-medical-analyst.service.js';
import type { ObservabilityPort } from '../application/ports/observability.port.js';
import { NoopObservabilityAdapter } from '../adapters/langfuse/noop-observability.adapter.js';

// ============================================================================
// Skill Loader
// ============================================================================

function loadDataStructurerSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'data-structurer',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch {
    console.warn('[AgenticStructurer] Could not load data-structurer SKILL.md, using fallback');
    return 'You are a medical data structuring specialist. Extract all data from the analysis into a comprehensive JSON structure.';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface StructurerEvent {
  type: 'log' | 'tool_call' | 'thinking' | 'json_update' | 'complete' | 'error';
  data: {
    message?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    iteration?: number;
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

const STRUCTURER_TOOLS = [
  {
    name: 'search_source',
    description: 'Search the full extracted source documents for specific values, markers, or terms. Use this to cross-check a value the analysis mentions, verify a date, or find data the analysis may have missed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The term to search for (e.g. "homocysteine", "TSH", "2019", "supplement")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_value_history',
    description: 'Get every recorded value for a specific lab marker across all source documents and dates. Use this to populate trend data points or verify the most recent value.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        marker: {
          type: Type.STRING,
          description: 'The lab marker name (e.g. "TSH", "Homocysteine", "Neutrophils")',
        },
      },
      required: ['marker'],
    },
  },
  {
    name: 'get_date_range',
    description: 'Get the full date range of the source data (earliest and latest dates, years spanned). Use this to accurately populate meta.dataSpan.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_source_documents',
    description: 'List all document sections available in the source data with their sizes. Use this to understand what raw data is available.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_json_section',
    description: 'Set a top-level OBJECT section of the JSON (not arrays). Use for: executiveSummary, meta, integrativeReasoning, prognosis, qualitativeData. For large ARRAY sections (criticalFindings, timeline, diagnoses, trends, connections, etc.) use append_to_section instead.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'The top-level JSON key (e.g. "executiveSummary", "meta", "integrativeReasoning")',
        },
        data: {
          type: Type.STRING,
          description: 'The JSON value as a string. Must be valid JSON.',
        },
      },
      required: ['section', 'data'],
    },
  },
  {
    name: 'append_to_section',
    description: 'Add a small batch of items (1-5) to a JSON array section. Use this for ALL large array sections: criticalFindings, timeline, diagnoses, trends, connections, actionPlan, supplementSchedule, lifestyleOptimizations, doctorQuestions, references, patterns, positiveFindings, dataGaps, monitoringProtocol. Add items in batches of 3-5 to keep each response small and avoid timeouts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'The array section name (e.g. "criticalFindings", "timeline", "diagnoses")',
        },
        items: {
          type: Type.STRING,
          description: 'A JSON array of 1-5 items to append, e.g. "[{...}, {...}]". Always wrap in an array even for a single item.',
        },
      },
      required: ['section', 'items'],
    },
  },
  {
    name: 'get_json_draft',
    description: 'Review the current state of the JSON being built. Shows which sections are populated and their sizes. Use this before calling complete_structuring to verify all required sections are present.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'complete_structuring',
    description: 'Signal that structuring is complete. IMPORTANT: You must have populated ALL required sections before calling this: executiveSummary, criticalFindings, timeline, diagnoses, systemsHealth. Also populate as many of: trends, connections, integrativeReasoning, prognosis, supplementSchedule, lifestyleOptimizations, actionPlan, doctorQuestions, dataGaps, references.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.STRING,
          description: 'Brief summary of what was structured (e.g. "18 critical findings, 12 timeline entries spanning 2007-2025, 8 diagnoses")',
        },
      },
      required: ['summary'],
    },
  },
];

// Required sections that must be present before completion is allowed
const REQUIRED_SECTIONS = [
  'executiveSummary',
  'criticalFindings',
  'timeline',
  'diagnoses',
  'systemsHealth',
];

// ============================================================================
// Tool Executor
// ============================================================================

export class StructurerToolExecutor {
  private parsedData: ReturnType<typeof parseExtractedData>;
  private currentJson: Map<string, unknown> = new Map();
  private searchesPerformed: Set<string> = new Set();

  constructor(extractedContent: string) {
    this.parsedData = parseExtractedData(extractedContent);
    console.log(`[AgenticStructurer] Parsed ${this.parsedData.totalSections} sections from source`);
  }

  execute(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'search_source':
        return this.searchSource(args.query as string);
      case 'get_value_history':
        return this.getValueHistory(args.marker as string);
      case 'get_date_range':
        return this.getDateRange();
      case 'list_source_documents':
        return this.listSourceDocuments();
      case 'update_json_section':
        return this.updateJsonSection(args.section as string, args.data as string);
      case 'append_to_section':
        return this.appendToSection(args.section as string, args.items as string);
      case 'get_json_draft':
        return this.getJsonDraft();
      case 'complete_structuring':
        return this.completeStructuring(args.summary as string);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private searchSource(query: string): string {
    if (!query) return 'Error: query is required';
    this.searchesPerformed.add(query.toLowerCase());

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
    const results: { section: string; matches: string[] }[] = [];

    for (const section of this.parsedData.sections) {
      const contentLower = section.content.toLowerCase();
      if (!queryTerms.some(t => contentLower.includes(t)) && !contentLower.includes(queryLower)) continue;

      const lines = section.content.split('\n');
      const matchingLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        if (queryTerms.some(t => lineLower.includes(t)) || lineLower.includes(queryLower)) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);
          const ctx = lines.slice(start, end + 1).join('\n');
          if (!matchingLines.includes(ctx)) matchingLines.push(ctx);
        }
      }

      if (matchingLines.length > 0) {
        results.push({
          section: section.pageNumber ? `${section.name} - Page ${section.pageNumber}` : section.name,
          matches: matchingLines,
        });
      }
    }

    if (results.length === 0) return `No matches found for "${query}" in source documents.`;

    const output = results
      .map(r => `### ${r.section}\n\n${r.matches.join('\n\n---\n\n')}`)
      .join('\n\n---\n\n');

    return `# Source Search: "${query}"\n\nFound in ${results.length} section(s):\n\n${output}`;
  }

  private getValueHistory(marker: string): string {
    if (!marker) return 'Error: marker is required';
    const markerLower = marker.toLowerCase();
    const results: Array<{ date: string; value: string; unit: string; document: string; context: string }> = [];

    for (const section of this.parsedData.sections) {
      const lines = section.content.split('\n');
      for (const line of lines) {
        if (!line.toLowerCase().includes(markerLower)) continue;

        const valuePatterns = [
          new RegExp(`${marker}[:\\s]+([\\d.,]+)\\s*(\\w*/\\w*|\\w+)?`, 'i'),
          new RegExp(`([\\d.,]+)\\s*(\\w*/\\w*|\\w+)?\\s*${marker}`, 'i'),
          /(\d+\.?\d*)\s*(mg\/dL|g\/dL|mmol\/L|μmol\/L|ng\/mL|pg\/mL|mIU\/L|IU\/mL|%|x10\^9\/L)?/i,
        ];

        for (const pattern of valuePatterns) {
          const match = line.match(pattern);
          if (match?.[1]) {
            const sectionDates = extractDatesFromText(section.content);
            const date = sectionDates.length > 0 ? sectionDates[0].date : 'Unknown date';
            results.push({
              date,
              value: match[1],
              unit: match[2] || '',
              document: section.name,
              context: line.trim().substring(0, 100),
            });
            break;
          }
        }
      }
    }

    if (results.length === 0) {
      return `No values found for "${marker}". Try search_source("${marker}") to see raw mentions.`;
    }

    results.sort((a, b) => a.date.localeCompare(b.date));
    const seen = new Set<string>();
    const unique = results.filter(r => {
      const key = `${r.date}-${r.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return `# Value History: "${marker}"\n\n**${unique.length} value(s) across ${new Set(unique.map(r => r.document)).size} document(s)**\n\n${
      unique.map(r => `- **${r.date}**: ${r.value} ${r.unit} — ${r.document}\n  Context: ${r.context}`).join('\n\n')
    }`;
  }

  private getDateRange(): string {
    const { dateRange, timelineEvents, documentsByYear } = this.parsedData;
    if (!dateRange) return 'No dates found in source documents.';

    const years = Object.keys(documentsByYear).map(Number).sort((a, b) => a - b);
    return `# Source Date Range

**Earliest:** ${dateRange.earliest}
**Latest:** ${dateRange.latest}
**Span:** ${dateRange.years} years
**Timeline Events Found:** ${timelineEvents.length}
**Years with Data:** ${years.join(', ')}

Use this to populate meta.dataSpan accurately.`;
  }

  private listSourceDocuments(): string {
    const docs = this.parsedData.documentNames.map(name => {
      const sections = this.parsedData.sections.filter(s => s.name === name);
      const chars = sections.reduce((sum, s) => sum + s.content.length, 0);
      return `- ${name} (${sections.length} section(s), ~${Math.round(chars / 1024)}KB)`;
    });

    return `# Source Documents\n\n${this.parsedData.documentNames.length} documents, ${this.parsedData.totalSections} total sections:\n\n${docs.join('\n')}`;
  }

  private updateJsonSection(section: string, data: string): string {
    if (!section) return 'Error: section name is required';
    if (!data) return 'Error: data is required';

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return `Error: data for section "${section}" is not valid JSON. Fix the JSON and try again.`;
    }

    this.currentJson.set(section, parsed);
    const size = data.length;
    return `Updated section "${section}" (~${Math.round(size / 1024)}KB)`;
  }

  private appendToSection(section: string, items: string): string {
    if (!section) return 'Error: section name is required';
    if (!items) return 'Error: items is required';

    let parsed: unknown;
    try {
      parsed = JSON.parse(items);
    } catch {
      return `Error: items for "${section}" is not valid JSON. Must be a JSON array, e.g. [{...}, {...}]`;
    }

    if (!Array.isArray(parsed)) {
      return `Error: items must be a JSON array. Got ${typeof parsed}. Wrap single items in an array: [{...}]`;
    }

    const existing = this.currentJson.get(section);
    if (existing === undefined) {
      this.currentJson.set(section, parsed);
    } else if (Array.isArray(existing)) {
      this.currentJson.set(section, [...existing, ...parsed]);
    } else {
      return `Error: "${section}" already exists as a non-array object. Use update_json_section to replace it.`;
    }

    const total = (this.currentJson.get(section) as unknown[]).length;
    return `Appended ${parsed.length} item(s) to "${section}" (${total} items total)`;
  }

  private getJsonDraft(): string {
    if (this.currentJson.size === 0) {
      return 'No sections written yet. Use update_json_section to start building the JSON.';
    }

    const lines = [`# JSON Draft Status\n\n**Sections written: ${this.currentJson.size}**\n`];

    for (const [section, value] of this.currentJson) {
      const size = JSON.stringify(value).length;
      if (Array.isArray(value)) {
        lines.push(`- ✅ **${section}**: ${(value as unknown[]).length} items (~${Math.round(size / 1024)}KB)`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`- ✅ **${section}**: object (~${Math.round(size / 1024)}KB)`);
      } else {
        lines.push(`- ✅ **${section}**: ${String(value).substring(0, 50)}`);
      }
    }

    const missing = REQUIRED_SECTIONS.filter(s => !this.currentJson.has(s));
    if (missing.length > 0) {
      lines.push(`\n**Still required:** ${missing.join(', ')}`);
    } else {
      lines.push('\n**All required sections present. Ready to call complete_structuring.**');
    }

    return lines.join('\n');
  }

  private completeStructuring(summary: string): string {
    const missing = REQUIRED_SECTIONS.filter(s => !this.currentJson.has(s));
    if (missing.length > 0) {
      return `Cannot complete: missing required sections: ${missing.join(', ')}. Use update_json_section to add them.`;
    }
    return `STRUCTURING_COMPLETE|${this.currentJson.size}|${summary}`;
  }

  getFinalJson(): string {
    const obj: Record<string, unknown> = {};
    for (const [section, value] of this.currentJson) {
      obj[section] = value;
    }
    return JSON.stringify(obj, null, 2);
  }

  getExternalStateSummary(): string {
    const lines = ['## JSON Sections Built (stored externally)'];

    if (this.currentJson.size === 0) {
      lines.push('No sections written yet.');
    } else {
      for (const [section, value] of this.currentJson) {
        const size = JSON.stringify(value).length;
        const detail = Array.isArray(value)
          ? `${(value as unknown[]).length} items`
          : typeof value === 'object' ? 'object' : String(value).substring(0, 30);
        lines.push(`- WRITTEN: ${section} (${detail}, ~${Math.round(size / 1024)}KB)`);
      }
    }

    const missing = REQUIRED_SECTIONS.filter(s => !this.currentJson.has(s));
    if (missing.length > 0) lines.push(`\nPENDING required: ${missing.join(', ')}`);

    lines.push('', '## Source Lookups Performed');
    lines.push(`Searches: ${this.searchesPerformed.size}`);
    for (const s of this.searchesPerformed) lines.push(`  - "${s}"`);

    return lines.join('\n');
  }
}

// ============================================================================
// Agentic Data Structurer
// ============================================================================

export class AgenticDataStructurer {
  private genai: GoogleGenAI;
  private model: string;
  private compressionService: ChatCompressionService;
  private readonly obs: ObservabilityPort;
  private readonly traceId: string;
  private readonly parentSpanId: string;

  constructor(
    billingContext?: BillingContext,
    observability?: ObservabilityPort,
    traceId?: string,
    parentSpanId?: string,
  ) {
    this.genai = createGoogleGenAI(billingContext);
    this.model = REALM_CONFIG.models.doctor;
    this.compressionService = new ChatCompressionService(this.genai, billingContext);
    this.obs = observability ?? new NoopObservabilityAdapter();
    this.traceId = traceId ?? '';
    this.parentSpanId = parentSpanId ?? '';
    console.log(`[AgenticStructurer] Initialized with model: ${this.model}`);
  }

  async *structure(
    extractedContent: string,
    analysisContent: string,
    researchMarkdown: string,
    patientContext?: string,
    maxIterations: number = 25,
  ): AsyncGenerator<StructurerEvent, string, unknown> {
    const toolExecutor = new StructurerToolExecutor(extractedContent);

    yield { type: 'log', data: { message: 'Starting agentic data structuring...' } };

    const systemPrompt = this.buildSystemPrompt(analysisContent, researchMarkdown, patientContext);

    let conversationHistory: Array<{
      role: string;
      parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: unknown; thoughtSignature?: string }>;
    }> = [
      { role: 'user', parts: [{ text: systemPrompt }] },
    ];

    let iteration = 0;
    let structuringComplete = false;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 1;

    while (!structuringComplete && iteration < maxIterations) {
      iteration++;

      if (iteration > 1) {
        await sleep(REALM_CONFIG.throttle.llm.delayBetweenRequestsMs);
      }

      yield { type: 'log', data: { message: `Structuring cycle ${iteration}/${maxIterations}...`, iteration } };

      // Compress conversation history if grown too large
      const compression = await this.compressionService.compressIfNeeded(
        conversationHistory,
        { phase: 'structurer', externalState: toolExecutor.getExternalStateSummary() },
      );
      if (compression.compressed) {
        conversationHistory = compression.newHistory;
        yield {
          type: 'log',
          data: {
            message: `[Compression] History compressed: ~${compression.originalTokenEstimate} -> ~${compression.newTokenEstimate} tokens`,
            iteration,
          },
        };
      }

      try {
        const genId = `gen-structurer-cycle-${iteration}`;
        try { this.obs.startGeneration(genId, { name: `cycle-${iteration}`, traceId: this.traceId, parentSpanId: this.parentSpanId, model: this.model }); } catch { /* non-fatal */ }

        // Log payload size so we can see what's being sent each cycle
        const payloadChars = JSON.stringify(conversationHistory).length;
        console.log(`[AgenticStructurer] Cycle ${iteration}: ${conversationHistory.length} history entries, ~${Math.round(payloadChars / 1024)}KB payload (~${Math.round(payloadChars / 4)} tokens est.)`);

        const response = await retryLLM(
          () => this.genai.models.generateContent({
            model: this.model,
            contents: conversationHistory,
            config: {
              tools: [{ functionDeclarations: STRUCTURER_TOOLS }],
            },
          }),
          { operationName: 'AgenticStructurer.generateContent' }
        );

        try {
          const usage = (response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
          if (usage) {
            console.log(`[AgenticStructurer] Cycle ${iteration} tokens: prompt=${usage.promptTokenCount} output=${usage.candidatesTokenCount} total=${usage.totalTokenCount}`);
          }
          this.obs.endGeneration(genId, {
            usage: usage ? {
              promptTokens: usage.promptTokenCount,
              completionTokens: usage.candidatesTokenCount,
              totalTokens: usage.totalTokenCount,
            } : undefined,
          });
        } catch { /* non-fatal */ }

        consecutiveFailures = 0;

        const rawResponse = response as unknown as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                functionCall?: { name: string; args?: Record<string, unknown> };
                thoughtSignature?: string;
                text?: string;
              }>;
            };
          }>;
        };

        const candidateParts = rawResponse.candidates?.[0]?.content?.parts || [];
        const functionCallParts = candidateParts.filter(p => p.functionCall);

        if (functionCallParts.length > 0) {
          const functionResponses: Array<{
            name: string;
            response: { result: string };
            thoughtSignature?: string;
          }> = [];

          for (const part of functionCallParts) {
            const call = part.functionCall!;
            const toolName = call.name;
            const toolArgs = (call.args || {}) as Record<string, unknown>;
            const thoughtSignature = part.thoughtSignature;

            yield { type: 'tool_call', data: { toolName, toolArgs, iteration } };

            const result = toolExecutor.execute(toolName, toolArgs);

            // Check completion signal
            if (result.startsWith('STRUCTURING_COMPLETE|')) {
              structuringComplete = true;
              const parts = result.split('|');
              yield {
                type: 'complete',
                data: { message: `Structuring complete: ${parts[2]} (${parts[1]} sections)`, iteration },
              };
              break;
            }

            yield {
              type: 'tool_call',
              data: {
                toolName,
                toolResult: result.substring(0, 500) + (result.length > 500 ? '...' : ''),
                iteration,
              },
            };

            if (toolName === 'update_json_section') {
              yield { type: 'json_update', data: { iteration } };
            }

            functionResponses.push({ name: toolName, response: { result }, thoughtSignature });
          }

          if (!structuringComplete) {
            conversationHistory.push({
              role: 'model',
              parts: functionCallParts.map(p => ({
                functionCall: p.functionCall,
                ...(p.thoughtSignature && { thoughtSignature: p.thoughtSignature }),
              })),
            });

            conversationHistory.push({
              role: 'user',
              parts: functionResponses.map(fr => ({
                functionResponse: { name: fr.name, response: fr.response },
                ...(fr.thoughtSignature && { thoughtSignature: fr.thoughtSignature }),
              })),
            });
          }
        } else {
          const text = (response as { text?: string }).text;
          if (text) {
            yield { type: 'thinking', data: { message: text.substring(0, 300), iteration } };
            conversationHistory.push({ role: 'model', parts: [{ text }] });
            conversationHistory.push({
              role: 'user',
              parts: [{ text: 'Continue structuring. Use update_json_section to build the JSON, or call complete_structuring when all required sections are done.' }],
            });
          }
        }
      } catch (error) {
        consecutiveFailures++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        try { this.obs.endGeneration(`gen-structurer-cycle-${iteration}`, { level: 'ERROR', statusMessage: errorMessage }); } catch { /* non-fatal */ }

        yield {
          type: 'error',
          data: { message: `Error in iteration ${iteration} (failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errorMessage}` },
        };

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          yield { type: 'log', data: { message: 'Too many consecutive failures, finalizing with partial JSON.' } };
          break;
        }

        conversationHistory.push({
          role: 'user',
          parts: [{ text: 'There was an error. Continue structuring using the available tools.' }],
        });
      }
    }

    if (!structuringComplete) {
      yield { type: 'log', data: { message: `Max iterations (${maxIterations}) reached. Finalizing with partial JSON.` } };
    }

    const finalJson = toolExecutor.getFinalJson();
    yield { type: 'log', data: { message: `Structuring complete: ${finalJson.length} chars` } };
    return finalJson;
  }

  private buildSystemPrompt(analysisContent: string, researchMarkdown: string, patientContext?: string): string {
    const skill = loadDataStructurerSkill();
    const questionBlock = patientContext
      ? `#### Patient's Question/Context\n${patientContext}\n\n`
      : '';

    return `${skill}

---

${questionBlock}### Priority 1: Medical Analysis (PRIMARY SOURCE)
<analysis>
${analysisContent}
</analysis>

### Priority 2: Research Findings
<research>
${researchMarkdown || 'No research available.'}
</research>

---

You have access to tools to query the full raw source documents when you need to:
- Verify an exact value the analysis mentions
- Find data spanning multiple years that the analysis may have summarized
- Cross-check a date, unit, or reference range

Build the JSON section by section using update_json_section. Call get_json_draft periodically to review progress. Call complete_structuring when all required sections are done.`;
  }
}
