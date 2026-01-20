/**
 * Agentic Medical Analyst Service
 *
 * An iterative, tool-using medical analyst that explores extracted medical data
 * like a real doctor would - forming hypotheses, seeking evidence, and building
 * comprehensive analysis through multiple exploration cycles.
 *
 * Tools available to the agent:
 * - list_documents: See what documents/sections exist
 * - read_document: Read a specific document section
 * - search_data: Search across all documents for specific terms
 * - get_analysis: Get the current state of the analysis
 * - update_analysis: Add or update sections of the analysis
 * - complete_analysis: Signal that exploration is complete
 */

import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../config.js';

// ============================================================================
// Skill Loader
// ============================================================================

function loadMedicalAnalysisSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'medical-analysis',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract content after frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[AgenticAnalyst] Could not load medical-analysis SKILL.md, using fallback');
    return 'You are an elite Integrative Systems Physician. Explore the patient data thoroughly using the available tools and build a comprehensive analysis.';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface AnalystEvent {
  type: 'log' | 'tool_call' | 'thinking' | 'analysis_update' | 'complete' | 'error';
  data: {
    message?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    analysisContent?: string;
    iteration?: number;
  };
}

interface DocumentSection {
  name: string;
  pageNumber?: number;
  content: string;
  startLine: number;
  endLine: number;
}

interface ParsedExtractedData {
  sections: DocumentSection[];
  documentNames: string[];
  totalCharacters: number;
  totalSections: number;
}

// ============================================================================
// Tool Definitions for Gemini Function Calling
// ============================================================================

const ANALYST_TOOLS = [
  {
    name: 'list_documents',
    description: 'List all documents/sections available in the extracted medical data. Use this first to understand what data you have to work with.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_document',
    description: 'Read the full content of a specific document section. Use the exact document name from list_documents.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        document_name: {
          type: Type.STRING,
          description: 'The name of the document to read (from list_documents)',
        },
      },
      required: ['document_name'],
    },
  },
  {
    name: 'search_data',
    description: 'Search across ALL documents for specific medical terms, markers, or patterns. Returns matching sections with context. Use this to find related data across different reports.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search query - can be a lab marker (e.g., "TSH", "neutrophils"), condition (e.g., "diabetes"), or pattern (e.g., "elevated", "low")',
        },
        include_context: {
          type: Type.BOOLEAN,
          description: 'Whether to include surrounding context (default: true)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_analysis',
    description: 'Get the current state of your analysis. Use this to review what you have written so far before adding more.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_analysis',
    description: 'Add new content or update a section of your analysis. You can specify a section to update, or append new content.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'The section name to update (e.g., "Executive Summary", "Critical Findings", "Metabolic Analysis"). Use "append" to add to the end.',
        },
        content: {
          type: Type.STRING,
          description: 'The markdown content to add or update',
        },
        replace: {
          type: Type.BOOLEAN,
          description: 'If true, replace the entire section. If false, append to it. Default: false',
        },
      },
      required: ['section', 'content'],
    },
  },
  {
    name: 'complete_analysis',
    description: 'Signal that your analysis is complete. Only call this when you have thoroughly explored the data and built a comprehensive analysis.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.STRING,
          description: 'A brief summary of what was covered in the analysis',
        },
        confidence: {
          type: Type.STRING,
          description: 'Your confidence level in the analysis: "high", "medium", or "low"',
        },
      },
      required: ['summary', 'confidence'],
    },
  },
];

// ============================================================================
// Extracted Data Parser
// ============================================================================

function parseExtractedData(extractedContent: string): ParsedExtractedData {
  const sections: DocumentSection[] = [];
  const lines = extractedContent.split('\n');

  // Pattern: ## [filename] - Page X or ## [filename]
  const sectionPattern = /^## \[([^\]]+)\](?:\s*-\s*Page\s*(\d+))?/;

  let currentSection: DocumentSection | null = null;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(sectionPattern);

    if (match) {
      // Save previous section
      if (currentSection) {
        currentSection.content = currentContent.join('\n').trim();
        currentSection.endLine = i - 1;
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        name: match[1],
        pageNumber: match[2] ? parseInt(match[2], 10) : undefined,
        content: '',
        startLine: i,
        endLine: i,
      };
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection) {
    currentSection.content = currentContent.join('\n').trim();
    currentSection.endLine = lines.length - 1;
    sections.push(currentSection);
  }

  // Get unique document names
  const documentNames = [...new Set(sections.map(s => s.name))];

  return {
    sections,
    documentNames,
    totalCharacters: extractedContent.length,
    totalSections: sections.length,
  };
}

// ============================================================================
// Tool Execution
// ============================================================================

class AnalystToolExecutor {
  private parsedData: ParsedExtractedData;
  private currentAnalysis: Map<string, string> = new Map();

  constructor(extractedContent: string) {
    this.parsedData = parseExtractedData(extractedContent);
  }

  execute(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'list_documents':
        return this.listDocuments();
      case 'read_document':
        return this.readDocument(args.document_name as string);
      case 'search_data':
        return this.searchData(args.query as string, args.include_context as boolean ?? true);
      case 'get_analysis':
        return this.getAnalysis();
      case 'update_analysis':
        return this.updateAnalysis(
          args.section as string,
          args.content as string,
          args.replace as boolean ?? false
        );
      case 'complete_analysis':
        return this.completeAnalysis(args.summary as string, args.confidence as string);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private listDocuments(): string {
    const docSummary = this.parsedData.documentNames.map(name => {
      const sections = this.parsedData.sections.filter(s => s.name === name);
      const totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);
      const pages = sections.map(s => s.pageNumber).filter(Boolean);

      return `- ${name} (${sections.length} section(s), ~${Math.round(totalChars / 1000)}K chars${pages.length ? `, pages ${pages.join(', ')}` : ''})`;
    });

    return `# Available Documents\n\nTotal: ${this.parsedData.totalSections} sections from ${this.parsedData.documentNames.length} documents\n\n${docSummary.join('\n')}\n\nUse read_document(document_name) to read a specific document, or search_data(query) to search across all documents.`;
  }

  private readDocument(documentName: string): string {
    const sections = this.parsedData.sections.filter(
      s => s.name.toLowerCase().includes(documentName.toLowerCase())
    );

    if (sections.length === 0) {
      return `Document not found: "${documentName}". Use list_documents() to see available documents.`;
    }

    const content = sections
      .map(s => {
        const header = s.pageNumber ? `## ${s.name} - Page ${s.pageNumber}` : `## ${s.name}`;
        return `${header}\n\n${s.content}`;
      })
      .join('\n\n---\n\n');

    return content;
  }

  private searchData(query: string, includeContext: boolean): string {
    const results: { section: string; matches: string[] }[] = [];
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

    for (const section of this.parsedData.sections) {
      const contentLower = section.content.toLowerCase();

      // Check if any query term matches
      const matchingTerms = queryTerms.filter(term => contentLower.includes(term));

      if (matchingTerms.length > 0 || contentLower.includes(queryLower)) {
        const lines = section.content.split('\n');
        const matchingLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          if (queryTerms.some(term => lineLower.includes(term)) || lineLower.includes(queryLower)) {
            if (includeContext) {
              // Include 2 lines before and after for context
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length - 1, i + 2);
              const contextLines = lines.slice(start, end + 1).join('\n');
              if (!matchingLines.includes(contextLines)) {
                matchingLines.push(contextLines);
              }
            } else {
              matchingLines.push(lines[i]);
            }
          }
        }

        if (matchingLines.length > 0) {
          results.push({
            section: section.pageNumber
              ? `${section.name} - Page ${section.pageNumber}`
              : section.name,
            matches: matchingLines.slice(0, 10), // Limit matches per section
          });
        }
      }
    }

    if (results.length === 0) {
      return `No matches found for "${query}". Try different terms or use list_documents() to see available data.`;
    }

    const output = results
      .slice(0, 15) // Limit total sections
      .map(r => `### ${r.section}\n\n${r.matches.join('\n\n---\n\n')}`)
      .join('\n\n---\n\n');

    return `# Search Results for "${query}"\n\nFound matches in ${results.length} section(s):\n\n${output}`;
  }

  private getAnalysis(): string {
    if (this.currentAnalysis.size === 0) {
      return 'Analysis is empty. Use update_analysis() to start building your analysis.';
    }

    const sections = Array.from(this.currentAnalysis.entries())
      .map(([section, content]) => `## ${section}\n\n${content}`)
      .join('\n\n---\n\n');

    return `# Current Analysis\n\n${sections}`;
  }

  private updateAnalysis(section: string, content: string, replace: boolean): string {
    if (section.toLowerCase() === 'append') {
      // Add as a new section with auto-generated name
      const sectionNum = this.currentAnalysis.size + 1;
      const newSection = `Section ${sectionNum}`;
      this.currentAnalysis.set(newSection, content);
      return `Added new section: "${newSection}"`;
    }

    if (replace || !this.currentAnalysis.has(section)) {
      this.currentAnalysis.set(section, content);
      return `Updated section: "${section}"`;
    } else {
      const existing = this.currentAnalysis.get(section) || '';
      this.currentAnalysis.set(section, existing + '\n\n' + content);
      return `Appended to section: "${section}"`;
    }
  }

  private completeAnalysis(summary: string, confidence: string): string {
    return `ANALYSIS_COMPLETE|${confidence}|${summary}`;
  }

  getFinalAnalysis(): string {
    if (this.currentAnalysis.size === 0) {
      return '';
    }

    // Order sections logically
    const sectionOrder = [
      'Executive Summary',
      'At a Glance',
      'The Big Picture',
      'Critical Findings',
      'Urgent Findings',
      'Key Patterns',
      'Primary Clinical Frames',
    ];

    const orderedSections: string[] = [];
    const usedSections = new Set<string>();

    // Add sections in preferred order first
    for (const preferredSection of sectionOrder) {
      for (const [section, content] of this.currentAnalysis) {
        if (section.toLowerCase().includes(preferredSection.toLowerCase())) {
          orderedSections.push(`## ${section}\n\n${content}`);
          usedSections.add(section);
        }
      }
    }

    // Add remaining sections
    for (const [section, content] of this.currentAnalysis) {
      if (!usedSections.has(section)) {
        orderedSections.push(`## ${section}\n\n${content}`);
      }
    }

    return `# Comprehensive Medical Analysis\n\n${orderedSections.join('\n\n---\n\n')}`;
  }

  getStats(): { documentsExplored: number; sectionsRead: number; searchesPerformed: number } {
    return {
      documentsExplored: this.parsedData.documentNames.length,
      sectionsRead: this.parsedData.totalSections,
      searchesPerformed: 0, // Would need to track this
    };
  }
}

// ============================================================================
// Agentic Medical Analyst
// ============================================================================

export class AgenticMedicalAnalyst {
  private genai: GoogleGenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }

    const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL;

    this.genai = new GoogleGenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });

    this.model = REALM_CONFIG.models.doctor;
    console.log(`[AgenticAnalyst] Initialized with model: ${this.model}`);
  }

  /**
   * Run the agentic medical analysis
   */
  async *analyze(
    extractedContent: string,
    patientContext?: string,
    maxIterations: number = 20
  ): AsyncGenerator<AnalystEvent, string, unknown> {
    const toolExecutor = new AnalystToolExecutor(extractedContent);

    yield {
      type: 'log',
      data: { message: 'Starting agentic medical analysis...' },
    };

    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(patientContext);

    // Conversation history for multi-turn
    const conversationHistory: Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: unknown;
        functionResponse?: unknown;
        thoughtSignature?: string;
      }>
    }> = [
      {
        role: 'user',
        parts: [{ text: systemPrompt }],
      },
    ];

    let iteration = 0;
    let analysisComplete = false;

    while (!analysisComplete && iteration < maxIterations) {
      iteration++;

      yield {
        type: 'log',
        data: { message: `Exploration cycle ${iteration}/${maxIterations}...`, iteration },
      };

      try {
        // Call the model with tools
        const response = await this.genai.models.generateContent({
          model: this.model,
          contents: conversationHistory,
          config: {
            tools: [{ functionDeclarations: ANALYST_TOOLS }],
          },
        });

        // Check for function calls
        // Access parts directly from candidates to get thoughtSignature (sibling to functionCall)
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
          functionCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
        };

        const candidateParts = rawResponse.candidates?.[0]?.content?.parts || [];
        const functionCallParts = candidateParts.filter(p => p.functionCall);

        if (functionCallParts.length > 0) {
          // Process each function call part (which includes thoughtSignature as sibling)
          const functionCallsWithSignatures: Array<{
            call: { name: string; args?: Record<string, unknown> };
            thoughtSignature?: string;
          }> = [];

          const functionResponses: Array<{
            name: string;
            response: { result: string };
            thoughtSignature?: string;
          }> = [];

          for (const part of functionCallParts) {
            const call = part.functionCall!;
            const toolName = call.name;
            const toolArgs = (call.args || {}) as Record<string, unknown>;

            // thoughtSignature is a sibling to functionCall in the part object
            const thoughtSignature = part.thoughtSignature;

            if (thoughtSignature) {
              yield {
                type: 'log',
                data: { message: `[Thought signature on ${toolName}: ${thoughtSignature.substring(0, 20)}...]`, iteration },
              };
            }

            functionCallsWithSignatures.push({ call, thoughtSignature });

            yield {
              type: 'tool_call',
              data: {
                toolName,
                toolArgs,
                iteration,
              },
            };

            // Execute the tool
            const result = toolExecutor.execute(toolName, toolArgs);

            // Check if analysis is complete
            if (result.startsWith('ANALYSIS_COMPLETE|')) {
              analysisComplete = true;
              const [, confidence, summary] = result.split('|');
              yield {
                type: 'complete',
                data: {
                  message: `Analysis complete (${confidence} confidence): ${summary}`,
                  iteration,
                },
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

            functionResponses.push({
              name: toolName,
              response: { result },
              thoughtSignature,
            });

            // If it was an analysis update, emit the event
            if (toolName === 'update_analysis') {
              yield {
                type: 'analysis_update',
                data: {
                  analysisContent: toolExecutor.getFinalAnalysis(),
                  iteration,
                },
              };
            }
          }

          if (!analysisComplete) {
            // Add the assistant's function calls to history
            // Include thought signature for each call (Vertex AI thinking models requirement)
            const modelParts = functionCallsWithSignatures.map(({ call, thoughtSignature }) => ({
              functionCall: call,
              ...(thoughtSignature && { thoughtSignature }),
            }));

            conversationHistory.push({
              role: 'model',
              parts: modelParts,
            });

            // Add function responses to history
            // Include thought signature in each response for Vertex AI
            const responseParts = functionResponses.map(fr => ({
              functionResponse: {
                name: fr.name,
                response: fr.response,
              },
              ...(fr.thoughtSignature && { thoughtSignature: fr.thoughtSignature }),
            }));

            conversationHistory.push({
              role: 'user',
              parts: responseParts,
            });
          }
        } else {
          // No function calls - the model is thinking or outputting text
          const text = response.text;
          if (text) {
            yield {
              type: 'thinking',
              data: { message: text.substring(0, 500), iteration },
            };

            // Add to history
            conversationHistory.push({
              role: 'model',
              parts: [{ text }],
            });

            // Prompt to continue
            conversationHistory.push({
              role: 'user',
              parts: [{
                text: 'Continue your analysis. Use the tools to explore more data, update your analysis, or call complete_analysis when done.',
              }],
            });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        yield {
          type: 'error',
          data: { message: `Error in iteration ${iteration}: ${errorMessage}` },
        };

        // Try to recover by prompting to continue
        conversationHistory.push({
          role: 'user',
          parts: [{
            text: `There was an error. Please continue your analysis using the available tools.`,
          }],
        });
      }
    }

    if (!analysisComplete) {
      yield {
        type: 'log',
        data: { message: `Max iterations (${maxIterations}) reached. Finalizing analysis...` },
      };
    }

    // Get the final analysis
    const finalAnalysis = toolExecutor.getFinalAnalysis();

    if (!finalAnalysis) {
      yield {
        type: 'error',
        data: { message: 'No analysis content generated' },
      };
      return 'Analysis generation failed - no content produced.';
    }

    yield {
      type: 'log',
      data: { message: `Analysis complete: ${finalAnalysis.length} characters` },
    };

    return finalAnalysis;
  }

  private buildSystemPrompt(patientContext?: string): string {
    // Load the comprehensive skill from file (includes task instructions)
    const skill = loadMedicalAnalysisSkill();

    // Build the prompt with skill + patient context (task instructions are in SKILL.md)
    let prompt = skill;

    if (patientContext) {
      prompt += `\n\n---\n\n## Patient's Question/Context\n\n${patientContext}`;
    }

    return prompt;
  }
}
