/**
 * Agentic HTML Renderer Service
 *
 * Replaces the single-shot Phase 7 HTML generation with an agentic loop.
 * The renderer builds the HTML section by section, with enforcement that
 * all array items are rendered before completion is allowed.
 *
 * Why agentic:
 * - Single-shot HTML generation loses 60–67% of array items (LLM attention fades)
 * - By requiring render_items() tool calls per array, the LLM cannot skip items
 * - complete_rendering() blocks if any array has fewer rendered items than JSON items
 *
 * Design:
 * - structuredData is accessible via get_section_data() — passed inline only as a summary
 * - htmlTemplate with {{SECTION:*}} placeholders is assembled by assembleFinalHtml()
 * - renderedSections/Items Maps are external state — never lost during compression
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
import {
  ChatCompressionService,
  type ConversationEntry,
} from './chat-compression.service.js';

// ============================================================================
// Skill Loader
// ============================================================================

function loadHtmlRendererSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'html-renderer',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch {
    console.warn('[AgenticRenderer] Could not load html-renderer SKILL.md, using fallback');
    return 'You are an HTML renderer. Render the structured JSON data into an HTML health report using the provided tools.';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface RendererEvent {
  type: 'log' | 'tool_call' | 'thinking' | 'complete' | 'error';
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

const RENDERER_TOOLS = [
  {
    name: 'get_render_progress',
    description: 'See which sections have been rendered and how many items have been rendered per array section. Call this at the start and frequently to track your progress.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_section_data',
    description: 'Get the structured JSON data for a specific section so you can render it. Pass the JSON field name (e.g., "criticalFindings", "timeline", "executiveSummary").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'JSON field name to retrieve (e.g., "criticalFindings", "executiveSummary", "timeline", "trends")',
        },
      },
      required: ['section'],
    },
  },
  {
    name: 'render_section',
    description: 'Store the rendered HTML for a non-array (object/string) section. Call this once per static section. Section name must match the placeholder (e.g., "EXECUTIVE_SUMMARY" for {{SECTION:EXECUTIVE_SUMMARY}}).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'Template placeholder name (e.g., "EXECUTIVE_SUMMARY", "INTEGRATIVE_REASONING", "SYSTEMS_HEALTH", "ORGAN_HEALTH", "PROGNOSIS")',
        },
        html: {
          type: Type.STRING,
          description: 'The complete rendered HTML for this section, including the section wrapper element.',
        },
      },
      required: ['section', 'html'],
    },
  },
  {
    name: 'render_items',
    description: 'Store rendered HTML items for an array section. Each call APPENDS to the section. The section is not complete until render_items has been called for ALL items. For large arrays, batch items in groups of 3–5 per call.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'Template placeholder name for ARRAY sections only (e.g., "CRITICAL_FINDINGS", "TIMELINE", "DIAGNOSES", "TRENDS", "CONNECTIONS", "PATTERNS", "LIFESTYLE", "DOCTOR_QUESTIONS", "MONITORING", "POSITIVE_FINDINGS", "DATA_GAPS", "REFERENCES"). For object sections (ACTION_PLAN, SUPPLEMENT_SCHEDULE, EXECUTIVE_SUMMARY, INTEGRATIVE_REASONING, SYSTEMS_HEALTH, ORGAN_HEALTH, PROGNOSIS) use render_section() instead.',
        },
        items: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Array of rendered HTML strings, one per JSON array item. Do not skip any items. For CRITICAL_FINDINGS, each item is a .gauge-card div. For TIMELINE, each item is a .timeline-item div. For DIAGNOSES, each is a .diagnosis-card div. For TRENDS, each is a .plotly-chart container div.',
        },
      },
      required: ['section', 'items'],
    },
  },
  {
    name: 'add_chart_js',
    description: 'Add Plotly JavaScript for chart initialization. Can be called multiple times — all blocks are concatenated. Place all Plotly.newPlot() calls here. Always call after rendering the corresponding HTML container.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        js: {
          type: Type.STRING,
          description: 'JavaScript code block with Plotly.newPlot() calls. Do not include <script> tags.',
        },
      },
      required: ['js'],
    },
  },
  {
    name: 'complete_rendering',
    description: 'Signal that all sections have been rendered. BLOCKED if any enforced array section has fewer rendered items than JSON items. Check get_render_progress() first to confirm all arrays show ✓ COMPLETE.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
];

// Sections where item count is strictly enforced
// key = template placeholder name, value = JSON field name
const ENFORCED_ARRAY_SECTIONS: Record<string, string> = {
  CRITICAL_FINDINGS: 'criticalFindings',
  TIMELINE: 'timeline',
  DIAGNOSES: 'diagnoses',
  TRENDS: 'trends',
};

// ============================================================================
// Tool Executor
// ============================================================================

export class HtmlRendererToolExecutor {
  // External state — never in conversation history, survives compression
  private renderedSections: Map<string, string> = new Map(); // SECTION_KEY → HTML
  private renderedItems: Map<string, string[]> = new Map();   // SECTION_KEY → HTML[]
  private chartJsBlocks: string[] = [];

  constructor(
    private structuredData: Record<string, unknown>,
    private htmlTemplate: string,
    private organInsights?: string,
  ) {}

  execute(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'get_render_progress': return this.getRenderProgress();
      case 'get_section_data':    return this.getSectionData(args.section as string);
      case 'render_section':      return this.renderSection(args.section as string, args.html as string);
      case 'render_items':        return this.renderItems(args.section as string, args.items as string[]);
      case 'add_chart_js':        return this.addChartJs(args.js as string);
      case 'complete_rendering':  return this.completeRendering();
      default: return `Unknown tool: ${toolName}`;
    }
  }

  private getRenderProgress(): string {
    const lines: string[] = ['# Render Progress\n'];

    // Static sections
    lines.push(`## Static Sections (${this.renderedSections.size} rendered)`);
    for (const [s, html] of this.renderedSections) {
      lines.push(`- ${s}: ✓ (${(html.length / 1024).toFixed(1)}KB)`);
    }

    // Array sections (enforced)
    lines.push('\n## Array Sections (enforced completeness)');
    for (const [placeholder, jsonField] of Object.entries(ENFORCED_ARRAY_SECTIONS)) {
      const jsonArray = this.structuredData[jsonField];
      const total = Array.isArray(jsonArray) ? jsonArray.length : 0;
      const rendered = this.renderedItems.get(placeholder)?.length ?? 0;
      const status = total === 0
        ? '— (no data)'
        : rendered >= total ? '✓ COMPLETE' : `⚠ ${rendered}/${total} — ${total - rendered} missing`;
      lines.push(`- ${placeholder} (${jsonField}): ${status}`);
    }

    // Other array sections (non-enforced — use render_items)
    lines.push('\n## Other Array Sections (use render_items)');
    const otherArraySections = ['CONNECTIONS', 'PATTERNS', 'LIFESTYLE',
      'DOCTOR_QUESTIONS', 'MONITORING', 'POSITIVE_FINDINGS', 'DATA_GAPS', 'REFERENCES'];
    for (const placeholder of otherArraySections) {
      const rendered = this.renderedItems.get(placeholder)?.length ?? 0;
      lines.push(`- ${placeholder}: ${rendered} items rendered`);
    }

    // Object sections (use render_section)
    lines.push('\n## Object Sections (use render_section)');
    const objectSections = ['EXECUTIVE_SUMMARY', 'INTEGRATIVE_REASONING', 'SYSTEMS_HEALTH',
      'ORGAN_HEALTH', 'ACTION_PLAN', 'SUPPLEMENT_SCHEDULE', 'PROGNOSIS'];
    for (const placeholder of objectSections) {
      const done = this.renderedSections.has(placeholder);
      lines.push(`- ${placeholder}: ${done ? '✓ done' : '— pending'}`);
    }

    lines.push(`\n## Chart JS: ${this.chartJsBlocks.length} block(s)`);
    return lines.join('\n');
  }

  private getSectionData(section: string): string {
    if (!section) return 'Error: section is required.';
    const data = this.structuredData[section];
    if (data === undefined) {
      // Also check organInsights
      if (section === 'organ_insights' && this.organInsights) {
        return `# organ_insights (markdown)\n\n${this.organInsights}`;
      }
      const keys = Object.keys(this.structuredData).join(', ');
      return `Field "${section}" not found in JSON.\nAvailable fields: ${keys}`;
    }
    const json = JSON.stringify(data, null, 2);
    return `# ${section}\n\n${json}`;
  }

  private renderSection(section: string, html: string): string {
    if (!section) return 'Error: section is required.';
    if (!html) return 'Error: html is required.';
    this.renderedSections.set(section, html);
    return `Stored ${section} (${(html.length / 1024).toFixed(1)}KB)`;
  }

  private renderItems(section: string, items: string[]): string {
    if (!section) return 'Error: section is required.';
    if (!items) return 'Error: items is required.';
    if (!Array.isArray(items)) return 'Error: items must be an array of HTML strings.';

    const existing = this.renderedItems.get(section) ?? [];
    const updated = [...existing, ...items];
    this.renderedItems.set(section, updated);

    // Report progress against enforced totals
    const jsonField = ENFORCED_ARRAY_SECTIONS[section];
    if (jsonField) {
      const jsonArray = this.structuredData[jsonField];
      const total = Array.isArray(jsonArray) ? jsonArray.length : '?';
      return `Stored ${items.length} item(s) for ${section} (${updated.length}/${total} total)`;
    }
    return `Stored ${items.length} item(s) for ${section} (${updated.length} total)`;
  }

  private addChartJs(js: string): string {
    if (!js) return 'Error: js is required.';
    this.chartJsBlocks.push(js);
    return `Added chart JS block ${this.chartJsBlocks.length}`;
  }

  private completeRendering(): string {
    const errors: string[] = [];

    for (const [placeholder, jsonField] of Object.entries(ENFORCED_ARRAY_SECTIONS)) {
      const jsonArray = this.structuredData[jsonField];
      if (!Array.isArray(jsonArray) || jsonArray.length === 0) continue;

      const rendered = this.renderedItems.get(placeholder)?.length ?? 0;
      if (rendered < jsonArray.length) {
        errors.push(`  - ${placeholder}: ${rendered}/${jsonArray.length} items rendered (${jsonArray.length - rendered} still missing)`);
      }
    }

    if (errors.length > 0) {
      return `RENDERING BLOCKED — these array sections are incomplete:\n${errors.join('\n')}\n\nUse render_items() to render all missing items, then call complete_rendering() again.`;
    }

    return 'RENDERING_COMPLETE|';
  }

  /**
   * Assemble the final HTML by injecting rendered sections into the template.
   * Called by AgenticHtmlRenderer after receiving RENDERING_COMPLETE signal.
   */
  assembleFinalHtml(reportDate: string): string {
    let html = this.htmlTemplate;

    // Replace static sections
    for (const [key, content] of this.renderedSections) {
      html = html.replace(`{{SECTION:${key}}}`, content);
    }

    // Replace array sections (join items into one block)
    // ACTION_PLAN and SUPPLEMENT_SCHEDULE are objects → handled by renderedSections loop above
    const allArraySections = [
      ...Object.keys(ENFORCED_ARRAY_SECTIONS),
      'CONNECTIONS', 'PATTERNS', 'LIFESTYLE',
      'DOCTOR_QUESTIONS', 'MONITORING', 'POSITIVE_FINDINGS', 'DATA_GAPS', 'REFERENCES',
    ];

    for (const placeholder of allArraySections) {
      const items = this.renderedItems.get(placeholder) ?? [];
      const sectionHtml = items.join('\n');
      html = html.replace(`{{SECTION:${placeholder}}}`, sectionHtml);
    }

    // Clear any remaining placeholders
    html = html.replace(/\{\{SECTION:[A-Z_]+\}\}/g, '');

    // Chart JS
    const chartScript = this.chartJsBlocks.length > 0
      ? `<script>\ndocument.addEventListener('DOMContentLoaded', function() {\n${this.chartJsBlocks.join('\n\n')}\n});\n</script>`
      : '';
    html = html.replace('{{CHARTS_INIT}}', chartScript);

    // Date and CSS
    html = html.replace('{{REPORT_DATE}}', reportDate);
    html = html.replace('{{ADDITIONAL_CSS}}', '');

    return html;
  }

  getExternalStateSummary(): string {
    return this.getRenderProgress();
  }

  getSectionSummary(): string {
    const lines: string[] = ['Available JSON sections:'];
    for (const [key, value] of Object.entries(this.structuredData)) {
      if (Array.isArray(value)) {
        lines.push(`- ${key}: array with ${value.length} items`);
      } else if (value && typeof value === 'object') {
        lines.push(`- ${key}: object`);
      } else if (value !== null && value !== undefined) {
        lines.push(`- ${key}: ${String(value).substring(0, 60)}`);
      }
    }
    if (this.organInsights) {
      lines.push('- organ_insights: markdown text (use section name "ORGAN_HEALTH")');
    }
    return lines.join('\n');
  }
}

// ============================================================================
// Agentic HTML Renderer
// ============================================================================

export class AgenticHtmlRenderer {
  private genai: GoogleGenAI;
  private compressionService: ChatCompressionService;

  constructor(billingContext?: BillingContext) {
    this.genai = createGoogleGenAI(billingContext);
    this.compressionService = new ChatCompressionService(this.genai, billingContext);
    console.log('[AgenticRenderer] Initialized');
  }

  async *render(
    structuredDataJson: string,
    htmlTemplate: string,
    organInsights?: string,
    maxIterations: number = 60,
    feedbackContext?: string,
  ): AsyncGenerator<RendererEvent, string, unknown> {
    // Parse the structured data
    let structuredData: Record<string, unknown>;
    try {
      structuredData = JSON.parse(structuredDataJson) as Record<string, unknown>;
    } catch {
      yield { type: 'error', data: { message: 'Could not parse structured data JSON — cannot render HTML' } };
      return '';
    }

    const toolExecutor = new HtmlRendererToolExecutor(structuredData, htmlTemplate, organInsights);
    const skill = loadHtmlRendererSkill();

    yield { type: 'log', data: { message: 'Starting agentic HTML rendering...' } };

    // Initial user message: a summary of what's in the JSON (not the full JSON)
    const sectionSummary = toolExecutor.getSectionSummary();
    const feedbackBlock = feedbackContext
      ? `\n\n## ⚠️ IMPORTANT — Previous Render Was Incomplete. Address These Issues:\n${feedbackContext}\n`
      : '';
    const initialMessage = `You are rendering a structured health report into HTML.
${feedbackBlock}
${sectionSummary}

Start by calling get_render_progress() to see the current state, then render each section:
1. For EACH section: call get_section_data(jsonField) to retrieve the data, then call render_section() or render_items()
2. For array sections with enforced completeness (criticalFindings→CRITICAL_FINDINGS, timeline→TIMELINE, diagnoses→DIAGNOSES, trends→TRENDS): you MUST render ALL items
3. Add all Plotly JavaScript using add_chart_js()
4. Call complete_rendering() only after all sections are done — it will reject if any enforced array is incomplete

Render every section that has data. Do not skip any.`;

    let conversationHistory: ConversationEntry[] = [
      { role: 'user', parts: [{ text: initialMessage }] },
    ];

    let iteration = 0;
    let renderingComplete = false;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 2;
    let finalHtml = '';

    while (!renderingComplete && iteration < maxIterations) {
      iteration++;

      if (iteration > 1) {
        await sleep(REALM_CONFIG.throttle.llm.delayBetweenRequestsMs);
      }

      yield { type: 'log', data: { message: `Rendering cycle ${iteration}/${maxIterations}...`, iteration } };

      // Compress history if needed
      const compression = await this.compressionService.compressIfNeeded(
        conversationHistory,
        { phase: 'renderer', externalState: toolExecutor.getExternalStateSummary() },
      );
      if (compression.compressed) {
        conversationHistory = compression.newHistory;
        yield {
          type: 'log',
          data: {
            message: `[Compression] History compressed: ~${compression.originalTokenEstimate} → ~${compression.newTokenEstimate} tokens`,
            iteration,
          },
        };
      }

      try {
        const payloadChars = JSON.stringify(conversationHistory).length;
        console.log(`[AgenticRenderer] Cycle ${iteration}: ${conversationHistory.length} history entries, ~${Math.round(payloadChars / 1024)}KB payload`);

        const response = await retryLLM(
          () => this.genai.models.generateContent({
            model: REALM_CONFIG.models.html,
            contents: conversationHistory,
            config: {
              systemInstruction: skill,
              tools: [{ functionDeclarations: RENDERER_TOOLS }],
            },
          }),
          { operationName: 'AgenticRenderer.generateContent' }
        );

        const usage = (response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
        if (usage) {
          console.log(`[AgenticRenderer] Cycle ${iteration} tokens: prompt=${usage.promptTokenCount} output=${usage.candidatesTokenCount} total=${usage.totalTokenCount}`);
        }

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

        const candidateParts = rawResponse.candidates?.[0]?.content?.parts ?? [];
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
            const toolArgs = (call.args ?? {}) as Record<string, unknown>;
            const thoughtSignature = part.thoughtSignature;

            yield { type: 'tool_call', data: { toolName, toolArgs, iteration } };

            const result = toolExecutor.execute(toolName, toolArgs);

            if (result === 'RENDERING_COMPLETE|') {
              renderingComplete = true;
              const reportDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              });
              finalHtml = toolExecutor.assembleFinalHtml(reportDate);
              yield {
                type: 'complete',
                data: { message: `Rendering complete. HTML assembled (${finalHtml.length} chars).`, iteration },
              };
              break;
            }

            yield {
              type: 'tool_call',
              data: {
                toolName,
                toolResult: result.substring(0, 300) + (result.length > 300 ? '...' : ''),
                iteration,
              },
            };

            functionResponses.push({ name: toolName, response: { result }, thoughtSignature });
          }

          if (!renderingComplete) {
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
          // No tool calls — nudge the LLM back on track
          const text = (response as { text?: string }).text ?? '';
          if (text) {
            yield { type: 'thinking', data: { message: text.substring(0, 300), iteration } };
          }
          conversationHistory.push({ role: 'model', parts: [{ text: text || 'Continuing...' }] });
          conversationHistory.push({
            role: 'user',
            parts: [{ text: 'Continue rendering using the available tools. Use get_render_progress() to check your current state, then render the next section.' }],
          });
        }
      } catch (error) {
        consecutiveFailures++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        yield {
          type: 'error',
          data: { message: `Error in iteration ${iteration} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errorMessage}` },
        };

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          yield { type: 'log', data: { message: 'Too many consecutive failures, finalizing with partial HTML.' } };
          break;
        }

        conversationHistory.push({
          role: 'user',
          parts: [{ text: 'There was an error. Continue rendering using the available tools.' }],
        });
      }
    }

    if (!renderingComplete) {
      yield { type: 'log', data: { message: `Max iterations (${maxIterations}) reached. Assembling partial HTML.` } };
      const reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      finalHtml = toolExecutor.assembleFinalHtml(reportDate);
    }

    yield { type: 'log', data: { message: `HTML renderer done: ${finalHtml.length} chars` } };
    return finalHtml;
  }
}
