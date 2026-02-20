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
import { retryLLM, sleep } from '../common/index.js';
import {
  createGoogleGenAI,
  type BillingContext,
} from '../utils/genai-factory.js';
import { ChatCompressionService } from './chat-compression.service.js';
import type { ObservabilityPort } from '../application/ports/observability.port.js';
import { NoopObservabilityAdapter } from '../adapters/langfuse/noop-observability.adapter.js';

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

interface TimelineEvent {
  date: string;           // ISO format: YYYY-MM-DD or YYYY-MM or YYYY
  year: number;
  month?: number;
  day?: number;
  document: string;       // Source document name
  event: string;          // Brief description
  snippet: string;        // Context snippet
}

interface DateRange {
  earliest: string;
  latest: string;
  years: number;
}

interface ParsedExtractedData {
  sections: DocumentSection[];
  documentNames: string[];
  totalCharacters: number;
  totalSections: number;
  // Temporal awareness
  dateRange: DateRange | null;
  documentsByYear: Record<number, string[]>;
  timelineEvents: TimelineEvent[];
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
    description: 'Get a section INDEX showing all sections you have written with their sizes. Use this frequently — it is cheap and does NOT grow history. To read a specific section\'s content, use get_section().',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_section',
    description: 'Read the full content of a specific analysis section you have previously written. First call get_analysis() to see the index, then call this to read one section before revising it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section_name: {
          type: Type.STRING,
          description: 'The section name from the get_analysis() index',
        },
      },
      required: ['section_name'],
    },
  },
  {
    name: 'update_analysis',
    description: 'Write exploration notes (during Phases 1–4) or synthesis sections (Phase 5 only). Use specific descriptive names — NEVER use "append". IMPORTANT: When writing findings that include lab values, ALWAYS include the exact numeric value, the unit (e.g., mg/dL, mIU/L), the reference range (e.g., ref 70-100), and the status flag (H/L) if applicable. Format: "Marker: Value Unit (ref Range) Flag". Example: "HbA1c: 5.7 % (ref 4.0-5.6) *H"',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'The section name to write. Use specific descriptive names — e.g., "OAT Panel Jul 2025", "Coagulation Findings Jan 2025", "Executive Summary". NEVER use "append".',
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
    description: 'Signal that your exploration and synthesis are complete. Requirements before calling: (1) read ≥80% of documents, (2) performed ≥10 searches, (3) called get_date_range() and extract_timeline_events(), (4) written ≥8 sections total, (5) completed all Phase 5 synthesis sections with replace=true (Executive Summary, System-by-System Analysis, Medical History Timeline, Unified Root Cause Hypothesis, Causal Chain, Keystone Findings, Recommendations, Missing Data).',
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
  // ============================================================================
  // P0: Temporal Awareness Tools
  // ============================================================================
  {
    name: 'get_date_range',
    description: 'Get the date range of all data in the extracted documents. Use this early to understand how many years of data you have. IMPORTANT: Your timeline should have entries proportional to this range.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_documents_by_year',
    description: 'List all documents grouped by year. Use this to see the temporal distribution of data and identify years you should explore.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'extract_timeline_events',
    description: 'Get ALL dated events extracted from the documents. This provides a comprehensive timeline of tests, diagnoses, and medical events. Use this to build a complete Medical History Timeline.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        year: {
          type: Type.NUMBER,
          description: 'Optional: Filter events to a specific year',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_value_history',
    description: 'Get the history of a specific lab marker across all documents and time points. Use this to track trends for important markers.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        marker: {
          type: Type.STRING,
          description: 'The lab marker to track (e.g., "TSH", "Homocysteine", "Neutrophils")',
        },
      },
      required: ['marker'],
    },
  },
];

// ============================================================================
// Extracted Data Parser
// ============================================================================

// ============================================================================
// Date Extraction Helpers
// ============================================================================

/**
 * Extract dates from text using multiple patterns
 * Returns dates in ISO format (YYYY-MM-DD, YYYY-MM, or YYYY)
 */
export function extractDatesFromText(text: string): Array<{ date: string; year: number; month?: number; day?: number; context: string }> {
  const dates: Array<{ date: string; year: number; month?: number; day?: number; context: string }> = [];
  const lines = text.split('\n');

  // Date patterns to match
  const patterns = [
    // ISO format: 2024-03-15, 2024-03, 2024/03/15
    /(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/g,
    // US format: 03/15/2024, 3/15/24
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g,
    // Written: March 15, 2024 or Mar 2024 or March 2024
    /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})?,?\s*(\d{4})/gi,
    // Written: 15 March 2024
    /(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})/gi,
  ];

  const monthMap: Record<string, number> = {
    'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
    'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
    'aug': 8, 'august': 8, 'sep': 9, 'september': 9, 'oct': 10, 'october': 10,
    'nov': 11, 'november': 11, 'dec': 12, 'december': 12
  };

  for (const line of lines) {
    // ISO and numeric formats
    let match;
    const isoPattern = /(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/g;
    while ((match = isoPattern.exec(line)) !== null) {
      const year = parseInt(match[1], 10);
      if (year >= 1990 && year <= 2030) {
        const month = parseInt(match[2], 10);
        const day = match[3] ? parseInt(match[3], 10) : undefined;
        const dateStr = day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${year}-${String(month).padStart(2, '0')}`;
        dates.push({ date: dateStr, year, month, day, context: line.trim().substring(0, 100) });
      }
    }

    // US format: MM/DD/YYYY
    const usPattern = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
    while ((match = usPattern.exec(line)) !== null) {
      let year = parseInt(match[3], 10);
      if (year < 100) year += 2000; // Convert 24 to 2024
      if (year >= 1990 && year <= 2030) {
        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        dates.push({ date: dateStr, year, month, day, context: line.trim().substring(0, 100) });
      }
    }

    // Written format: Month DD, YYYY or Month YYYY
    const writtenPattern = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})?,?\s*(\d{4})/gi;
    while ((match = writtenPattern.exec(line)) !== null) {
      const year = parseInt(match[3], 10);
      if (year >= 1990 && year <= 2030) {
        const month = monthMap[match[1].toLowerCase().substring(0, 3)];
        const day = match[2] ? parseInt(match[2], 10) : undefined;
        const dateStr = day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${year}-${String(month).padStart(2, '0')}`;
        dates.push({ date: dateStr, year, month, day, context: line.trim().substring(0, 100) });
      }
    }
  }

  // Deduplicate by date string
  const seen = new Set<string>();
  return dates.filter(d => {
    const key = d.date + d.context;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse extracted content into sections with temporal awareness
 */
export function parseExtractedData(extractedContent: string): ParsedExtractedData {
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

  // ============================================================================
  // Extract temporal data
  // ============================================================================

  const timelineEvents: TimelineEvent[] = [];
  const documentsByYear: Record<number, string[]> = {};
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  for (const section of sections) {
    const dates = extractDatesFromText(section.content);

    for (const dateInfo of dates) {
      // Track timeline events
      timelineEvents.push({
        date: dateInfo.date,
        year: dateInfo.year,
        month: dateInfo.month,
        day: dateInfo.day,
        document: section.name,
        event: section.name, // Use document name as event type
        snippet: dateInfo.context,
      });

      // Track documents by year
      if (!documentsByYear[dateInfo.year]) {
        documentsByYear[dateInfo.year] = [];
      }
      if (!documentsByYear[dateInfo.year].includes(section.name)) {
        documentsByYear[dateInfo.year].push(section.name);
      }

      // Track date range
      if (!earliestDate || dateInfo.date < earliestDate) {
        earliestDate = dateInfo.date;
      }
      if (!latestDate || dateInfo.date > latestDate) {
        latestDate = dateInfo.date;
      }
    }
  }

  // Sort timeline events by date
  timelineEvents.sort((a, b) => a.date.localeCompare(b.date));

  // Calculate date range
  let dateRange: DateRange | null = null;
  if (earliestDate && latestDate) {
    const earliestYear = parseInt(earliestDate.substring(0, 4), 10);
    const latestYear = parseInt(latestDate.substring(0, 4), 10);
    dateRange = {
      earliest: earliestDate,
      latest: latestDate,
      years: latestYear - earliestYear + 1,
    };
  }

  console.log(`[AgenticAnalyst] Parsed ${sections.length} sections, ${timelineEvents.length} timeline events, date range: ${dateRange?.earliest} to ${dateRange?.latest} (${dateRange?.years} years)`);

  return {
    sections,
    documentNames,
    totalCharacters: extractedContent.length,
    totalSections: sections.length,
    dateRange,
    documentsByYear,
    timelineEvents,
  };
}

// ============================================================================
// Analysis Completion Requirements
// ============================================================================

// Coverage-based thresholds — no keyword matching.
// The structurer has tool-based access to source data and will build its own JSON.
const MIN_DOCUMENT_COVERAGE = 80;   // % of documents that must be read
const MIN_SEARCHES = 10;            // minimum searches performed
const MIN_SECTIONS = 8;             // minimum sections written (notes + synthesis)
const MIN_TOTAL_CONTENT_KB = 15;    // minimum KB of analysis content

// ============================================================================
// Tool Execution
// ============================================================================

export class AnalystToolExecutor {
  private parsedData: ParsedExtractedData;
  private currentAnalysis: Map<string, string> = new Map();

  // Tracking for enforcement
  private documentsRead: Set<string> = new Set();
  private searchesPerformed: Set<string> = new Set();
  private dateRangeChecked: boolean = false;
  private timelineExtracted: boolean = false;

  constructor(extractedContent: string) {
    this.parsedData = parseExtractedData(extractedContent);
  }

  // Get coverage stats for enforcement
  getCoverageStats(): {
    documentsRead: number;
    totalDocuments: number;
    documentCoverage: number;
    searchesPerformed: number;
    analysisSections: number;
    dateRangeChecked: boolean;
    timelineExtracted: boolean;
  } {
    const totalDocs = this.parsedData.documentNames.length;
    const readCount = this.documentsRead.size;
    return {
      documentsRead: readCount,
      totalDocuments: totalDocs,
      documentCoverage: totalDocs > 0 ? Math.round((readCount / totalDocs) * 100) : 0,
      searchesPerformed: this.searchesPerformed.size,
      analysisSections: this.currentAnalysis.size,
      dateRangeChecked: this.dateRangeChecked,
      timelineExtracted: this.timelineExtracted,
    };
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
      case 'get_section':
        return this.getSection(args.section_name as string);
      case 'update_analysis':
        return this.updateAnalysis(
          args.section as string,
          args.content as string,
          args.replace as boolean ?? false
        );
      case 'complete_analysis':
        return this.completeAnalysis(args.summary as string, args.confidence as string);
      // P0: Temporal Awareness Tools
      case 'get_date_range':
        return this.getDateRange();
      case 'list_documents_by_year':
        return this.listDocumentsByYear();
      case 'extract_timeline_events':
        return this.extractTimelineEvents(args.year as number | undefined);
      case 'get_value_history':
        return this.getValueHistory(args.marker as string);
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

    // Track that this document was read
    for (const section of sections) {
      this.documentsRead.add(section.name);
    }

    const content = sections
      .map(s => {
        const header = s.pageNumber ? `## ${s.name} - Page ${s.pageNumber}` : `## ${s.name}`;
        return `${header}\n\n${s.content}`;
      })
      .join('\n\n---\n\n');

    // No size cap — chat compression service handles conversation history growth
    return content;
  }

  private searchData(query: string, includeContext: boolean): string {
    // Track searches performed
    this.searchesPerformed.add(query.toLowerCase());
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
            matches: matchingLines,
          });
        }
      }
    }

    if (results.length === 0) {
      return `No matches found for "${query}". Try different terms or use list_documents() to see available data.`;
    }

    const output = results
      .map(r => `### ${r.section}\n\n${r.matches.join('\n\n---\n\n')}`)
      .join('\n\n---\n\n');

    // No slice caps — chat compression service handles conversation history growth
    return `# Search Results for "${query}"\n\nFound matches in ${results.length} section(s):\n\n${output}`;
  }

  private getAnalysis(): string {
    if (this.currentAnalysis.size === 0) {
      return 'No sections written yet. Use update_analysis() to start taking exploration notes.';
    }
    const index = Array.from(this.currentAnalysis.entries())
      .map(([section, content]) => `- "${section}" (${(content.length / 1024).toFixed(1)}KB)`)
      .join('\n');
    const totalKB = Array.from(this.currentAnalysis.values())
      .reduce((sum, c) => sum + c.length, 0) / 1024;
    return `# Analysis Index — ${this.currentAnalysis.size} section(s), ${totalKB.toFixed(1)}KB total\n\n${index}\n\nUse get_section(section_name) to read a specific section's full content.`;
  }

  private getSection(sectionName: string): string {
    if (!sectionName) return 'Error: section_name is required.';
    if (this.currentAnalysis.has(sectionName)) {
      return `# ${sectionName}\n\n${this.currentAnalysis.get(sectionName)}`;
    }
    const available = Array.from(this.currentAnalysis.keys()).map(k => `- "${k}"`).join('\n');
    return `Section "${sectionName}" not found. Use the exact name from get_analysis().\n\nAvailable sections:\n${available}`;
  }

  private updateAnalysis(section: string, content: string, replace: boolean): string {
    if (section.toLowerCase() === 'append') {
      return `Error: "append" is not a valid section name. Provide a specific descriptive name.\nExamples: "OAT Panel Jul 2025", "Coagulation Findings Jan 2025", "Executive Summary"`;
    }

    const prevContent = this.currentAnalysis.get(section);
    const prevSizeKB = prevContent ? (prevContent.length / 1024).toFixed(1) : null;

    if (replace || !this.currentAnalysis.has(section)) {
      this.currentAnalysis.set(section, content);
      const newSizeKB = (content.length / 1024).toFixed(1);
      return prevSizeKB
        ? `Replaced "${section}" (was ${prevSizeKB}KB → now ${newSizeKB}KB)`
        : `Written "${section}" (${newSizeKB}KB)`;
    } else {
      const newContent = prevContent + '\n\n' + content;
      this.currentAnalysis.set(section, newContent);
      const newSizeKB = (newContent.length / 1024).toFixed(1);
      return `Appended to "${section}" (was ${prevSizeKB}KB → now ${newSizeKB}KB). Use replace=true to overwrite instead of append.`;
    }
  }

  private completeAnalysis(summary: string, confidence: string): string {
    // Enforce minimum coverage requirements before allowing completion
    const stats = this.getCoverageStats();
    const issues: string[] = [];

    // Document coverage — allow edge cases with very large doc sets
    if (stats.documentCoverage < MIN_DOCUMENT_COVERAGE && stats.totalDocuments > 2) {
      issues.push(`Only ${stats.documentCoverage}% of documents read (${stats.documentsRead}/${stats.totalDocuments}). Read at least ${MIN_DOCUMENT_COVERAGE}% of documents before completing.`);
    }

    // Search depth — comprehensive analysis needs many cross-references
    if (stats.searchesPerformed < MIN_SEARCHES) {
      issues.push(`Only ${stats.searchesPerformed} searches performed (need ${MIN_SEARCHES}). Use search_data() to cross-reference findings, trace causal chains, and find patterns.`);
    }

    // Temporal tools — required for timeline completeness
    if (!stats.dateRangeChecked) {
      issues.push(`Date range not checked. Call get_date_range() to understand the temporal scope of the data.`);
    }

    if (!stats.timelineExtracted && this.parsedData.timelineEvents.length > 0) {
      issues.push(`Timeline events not extracted. Call extract_timeline_events() to build the Medical History Timeline.`);
    }

    // Section depth — ensures meaningful exploration happened
    if (stats.analysisSections < MIN_SECTIONS) {
      issues.push(`Only ${stats.analysisSections} sections written (need ${MIN_SECTIONS}). Write more exploration notes and synthesis sections before completing.`);
    }

    // Content depth — ensures meaningful content was written
    const totalContentKB = Array.from(this.currentAnalysis.values())
      .reduce((sum, c) => sum + c.length, 0) / 1024;
    if (totalContentKB < MIN_TOTAL_CONTENT_KB) {
      issues.push(`Only ${totalContentKB.toFixed(1)}KB of analysis written (need ${MIN_TOTAL_CONTENT_KB}KB). Write more detailed findings before completing.`);
    }

    // Temporal year coverage enforcement — for multi-year datasets
    const { dateRange, documentsByYear } = this.parsedData;
    if (dateRange && dateRange.years >= 5) {
      const yearsWithDataInSource = Object.keys(documentsByYear).map(Number).sort((a, b) => a - b);
      if (yearsWithDataInSource.length >= 3) {
        // Find the timeline section content
        let timelineContent = '';
        for (const [key, content] of this.currentAnalysis) {
          if (key.toLowerCase().includes('timeline')) {
            timelineContent += content + '\n';
          }
        }

        if (timelineContent) {
          // Extract 4-digit years mentioned in the timeline
          const yearMatches = timelineContent.match(/\b(19[9]\d|20[0-2]\d)\b/g) ?? [];
          const yearsInTimeline = new Set(yearMatches.map(y => parseInt(y, 10)));
          const missingFromTimeline = yearsWithDataInSource.filter(y => !yearsInTimeline.has(y));
          const missingRatio = missingFromTimeline.length / yearsWithDataInSource.length;

          if (missingRatio > 0.4) {
            issues.push(
              `Medical History Timeline is missing ${missingFromTimeline.length}/${yearsWithDataInSource.length} years that have data in the source (${missingFromTimeline.join(', ')}). ` +
              `Update your timeline to include ALL years with data. ` +
              `Do NOT write "The Gap" — include what was found for each year, even if labs were normal (e.g., "2014: Stable CBC. Lipid panel within range.").`
            );
          }
        }
      }
    }

    // If there are issues, return them instead of completing
    if (issues.length > 0) {
      return `# Cannot Complete Analysis Yet

The following requirements are not met:

${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Current Coverage Stats
- Documents read: ${stats.documentsRead}/${stats.totalDocuments} (${stats.documentCoverage}%)
- Searches performed: ${stats.searchesPerformed} (need ${MIN_SEARCHES})
- Analysis sections: ${stats.analysisSections} (need ${MIN_SECTIONS})
- Total content: ${totalContentKB.toFixed(1)}KB (need ${MIN_TOTAL_CONTENT_KB}KB)
- Date range checked: ${stats.dateRangeChecked ? 'Yes' : 'No'}
- Timeline extracted: ${stats.timelineExtracted ? 'Yes' : 'No'}

Please address these issues before calling complete_analysis() again.`;
    }

    // All requirements met - allow completion
    return `ANALYSIS_COMPLETE|${confidence}|${summary}`;
  }

  // ============================================================================
  // P0: Temporal Awareness Tools
  // ============================================================================

  private getDateRange(): string {
    // Track that date range was checked
    this.dateRangeChecked = true;

    const { dateRange, timelineEvents } = this.parsedData;

    if (!dateRange) {
      return `# Date Range\n\nNo dates found in the extracted documents. This may indicate the documents lack explicit date markers.`;
    }

    const yearsWithData = Object.keys(this.parsedData.documentsByYear).map(Number).sort((a, b) => a - b);
    const allYears = [];
    for (let y = parseInt(dateRange.earliest.substring(0, 4), 10); y <= parseInt(dateRange.latest.substring(0, 4), 10); y++) {
      allYears.push(y);
    }
    const missingYears = allYears.filter(y => !yearsWithData.includes(y));

    return `# Date Range Summary

**Earliest Date:** ${dateRange.earliest}
**Latest Date:** ${dateRange.latest}
**Span:** ${dateRange.years} years

**Total Timeline Events Found:** ${timelineEvents.length}
**Years with Data:** ${yearsWithData.join(', ')}
${missingYears.length > 0 ? `**Years with No Data:** ${missingYears.join(', ')}` : '**Coverage:** Complete - data found for all years'}

---

**IMPORTANT:** Your Medical History Timeline should include entries proportional to this ${dateRange.years}-year span.
If data spans 18 years, aim for at least 10-15 timeline entries, not just 2-3 recent ones.

Use \`list_documents_by_year()\` to see documents per year, or \`extract_timeline_events()\` to get all dated events.`;
  }

  private listDocumentsByYear(): string {
    const { documentsByYear, dateRange } = this.parsedData;

    if (Object.keys(documentsByYear).length === 0) {
      return `# Documents by Year\n\nNo dated documents found.`;
    }

    const years = Object.keys(documentsByYear).map(Number).sort((a, b) => a - b);
    const output = years.map(year => {
      const docs = documentsByYear[year];
      return `## ${year}\n${docs.map(d => `- ${d}`).join('\n')}`;
    }).join('\n\n');

    return `# Documents by Year

**Date Range:** ${dateRange?.earliest} to ${dateRange?.latest}
**Years with Data:** ${years.length}

${output}

---

Use \`extract_timeline_events(year)\` to get detailed events for a specific year.`;
  }

  /**
   * Build a compact year-by-year scaffold from timeline events.
   * Auto-injected into currentAnalysis when extract_timeline_events() is called.
   * Guarantees every year with source data appears in the timeline.
   */
  private buildTimelineScaffold(events: TimelineEvent[]): string {
    const byYear: Record<number, TimelineEvent[]> = {};
    for (const event of events) {
      if (!byYear[event.year]) byYear[event.year] = [];
      byYear[event.year].push(event);
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    const rows = years.map(y => {
      const yearEvents = byYear[y];
      const uniqueDocs = [...new Set(yearEvents.map(e => e.document))];
      const docsStr = uniqueDocs.slice(0, 3).join(', ') + (uniqueDocs.length > 3 ? ` +${uniqueDocs.length - 3} more` : '');
      return `| ${y} | ${yearEvents.length} | ${docsStr} |`;
    }).join('\n');

    return `*Auto-extracted scaffold from source data — enrich each year with clinical findings. NEVER summarize a period as "The Gap" — include what was found for each year, even if tests were normal.*\n\n| Year | Events | Source Documents |\n|------|--------|------------------|\n${rows}\n\n**Required:** Replace each year row above with a proper clinical entry such as:\n- "2008: Stable CBC (WBC 6.2, Plt 210). Lipid panel normal. No active issues noted."\n- "2015: Thyroid function within range (TSH 2.1). Routine metabolic panel normal."`;
  }

  private extractTimelineEvents(year?: number): string {
    // Track that timeline was extracted
    this.timelineExtracted = true;

    let events = this.parsedData.timelineEvents;

    if (year) {
      events = events.filter(e => e.year === year);
    }

    if (events.length === 0) {
      return year
        ? `# Timeline Events for ${year}\n\nNo events found for year ${year}.`
        : `# Timeline Events\n\nNo dated events found in the documents.`;
    }

    // Auto-inject scaffold into analysis (full call only, not per-year)
    // Only inject if no timeline section has been written yet
    if (!year) {
      const hasTimeline = [...this.currentAnalysis.keys()].some(k => k.toLowerCase().includes('timeline'));
      if (!hasTimeline) {
        this.currentAnalysis.set('Medical History Timeline', this.buildTimelineScaffold(events));
      }
    }

    // Group by year for readability
    const byYear: Record<number, TimelineEvent[]> = {};
    for (const event of events) {
      if (!byYear[event.year]) byYear[event.year] = [];
      byYear[event.year].push(event);
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    const output = years.map(y => {
      const yearEvents = byYear[y];
      const eventList = yearEvents.map(e => {
        const dateStr = e.day ? e.date : (e.month ? `${e.year}-${String(e.month).padStart(2, '0')}` : `${e.year}`);
        return `- **${dateStr}** - ${e.document}: ${e.snippet.substring(0, 80)}${e.snippet.length > 80 ? '...' : ''}`;
      }).join('\n');
      return `## ${y} (${yearEvents.length} events)\n${eventList}`;
    }).join('\n\n');

    return `# Timeline Events${year ? ` for ${year}` : ''}

**Total Events:** ${events.length}
${!year && this.parsedData.dateRange ? `**Date Range:** ${this.parsedData.dateRange.earliest} to ${this.parsedData.dateRange.latest}` : ''}

${output}

---

**A preliminary "Medical History Timeline" scaffold has been auto-inserted into your analysis.**
Enrich each year row with clinical detail from the events above.
NEVER write "The Gap" — include a brief entry for every year shown, even if labs were normal.`;
  }

  private getValueHistory(marker: string): string {
    if (!marker) {
      return `Error: Please provide a marker name (e.g., "TSH", "Homocysteine", "Neutrophils")`;
    }

    const markerLower = marker.toLowerCase();
    const results: Array<{ date: string; value: string; unit: string; document: string; context: string }> = [];

    // Search for the marker in all sections
    for (const section of this.parsedData.sections) {
      const lines = section.content.split('\n');

      for (const line of lines) {
        const lineLower = line.toLowerCase();
        if (lineLower.includes(markerLower)) {
          // Try to extract a numeric value near the marker
          // Pattern: marker followed by number with optional unit
          const valuePatterns = [
            new RegExp(`${marker}[:\\s]+([\\d.,]+)\\s*(\\w*/\\w*|\\w+)?`, 'i'),
            new RegExp(`([\\d.,]+)\\s*(\\w*/\\w*|\\w+)?\\s*${marker}`, 'i'),
            /(\d+\.?\d*)\s*(mg\/dL|g\/dL|mmol\/L|μmol\/L|ng\/mL|pg\/mL|mIU\/L|IU\/mL|%|x10\^9\/L|cells\/μL)?/i,
          ];

          for (const pattern of valuePatterns) {
            const match = line.match(pattern);
            if (match && match[1]) {
              // Try to find a date in the same section
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
    }

    if (results.length === 0) {
      return `# Value History for "${marker}"\n\nNo values found for marker "${marker}". Try:\n- A different spelling or abbreviation\n- search_data("${marker}") to find related content`;
    }

    // Sort by date
    results.sort((a, b) => a.date.localeCompare(b.date));

    // Deduplicate by date+value
    const seen = new Set<string>();
    const unique = results.filter(r => {
      const key = `${r.date}-${r.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const output = unique.map(r =>
      `- **${r.date}**: ${r.value} ${r.unit} (${r.document})\n  Context: ${r.context}`
    ).join('\n\n');

    return `# Value History for "${marker}"

**Found ${unique.length} value(s) across ${new Set(unique.map(r => r.document)).size} document(s)**

${output}

---

Use this history to identify trends (improving, worsening, stable) in your analysis.`;
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
      'Patient Context',
      'Key Metrics',
      'Critical Findings',
      'Urgent Findings',
      'Key Patterns',
      'Primary Clinical Frames',
      'System',
      'Diagnoses',
      'Timeline',
      'Root Cause',
      'Unified',
      'Causal Chain',
      'Keystone',
      'Cross-System',
      'Competing',
      'Integrative',
      'Prognosis',
      'Outlook',
      'Supplement',
      'Lifestyle',
      'Recommendations',
      'Questions for Doctor',
      'Missing Data',
      'Data Gaps',
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

  /**
   * Get a summary of externally-stored state for the compression prompt.
   * This tells the compressor what's stored outside conversation history
   * (analysis sections, exploration progress) so nothing is lost.
   */
  getExternalStateSummary(): string {
    const lines: string[] = [];

    // Analysis sections written (stored in this.currentAnalysis Map)
    lines.push('## Analysis Sections (stored externally)');
    if (this.currentAnalysis.size === 0) {
      lines.push('No sections written yet.');
    } else {
      for (const [section, content] of this.currentAnalysis) {
        lines.push(`- WRITTEN: ${section} (~${Math.round(content.length / 1024)}KB)`);
      }
    }

    // Exploration progress
    lines.push('', '## Exploration Progress');
    const read = [...this.documentsRead];
    const all = this.parsedData.documentNames;
    const unread = all.filter(d => !this.documentsRead.has(d));
    lines.push(`Documents read: ${read.length}/${all.length}`);
    for (const d of read) lines.push(`  - READ: ${d}`);
    for (const d of unread) lines.push(`  - UNREAD: ${d}`);

    lines.push(`Searches performed: ${this.searchesPerformed.size}`);
    for (const s of this.searchesPerformed) lines.push(`  - "${s}"`);

    lines.push(`Date range checked: ${this.dateRangeChecked ? 'Yes' : 'No'}`);
    lines.push(`Timeline extracted: ${this.timelineExtracted ? 'Yes' : 'No'}`);

    return lines.join('\n');
  }
}

// ============================================================================
// Agentic Medical Analyst
// ============================================================================

export class AgenticMedicalAnalyst {
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
    console.log(`[AgenticAnalyst] Initialized with model: ${this.model}`);
  }

  /**
   * Run the agentic medical analysis
   */
  async *analyze(
    extractedContent: string,
    patientContext?: string,
    maxIterations: number = 200
  ): AsyncGenerator<AnalystEvent, string, unknown> {
    const toolExecutor = new AnalystToolExecutor(extractedContent);

    yield {
      type: 'log',
      data: { message: 'Starting agentic medical analysis...' },
    };

    // Build the system prompt
    const systemPrompt = this.buildSystemPrompt(patientContext);

    // Conversation history for multi-turn
    let conversationHistory: Array<{
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

      // Add delay between LLM calls to prevent rate limiting (skip first iteration)
      if (iteration > 1) {
        const delayMs = REALM_CONFIG.throttle.llm.delayBetweenRequestsMs;
        await sleep(delayMs);
      }

      yield {
        type: 'log',
        data: { message: `Exploration cycle ${iteration}/${maxIterations}...`, iteration },
      };

      // Compress conversation history if it has grown too large
      const compression = await this.compressionService.compressIfNeeded(
        conversationHistory,
        { phase: 'analyst', externalState: toolExecutor.getExternalStateSummary() },
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
        // Observability: track each generateContent call
        const genId = `gen-analyst-cycle-${iteration}`;
        try { this.obs.startGeneration(genId, { name: `cycle-${iteration}`, traceId: this.traceId, parentSpanId: this.parentSpanId, model: this.model }); } catch { /* non-fatal */ }

        // Call the model with tools
        const response = await retryLLM(
          () => this.genai.models.generateContent({
            model: this.model,
            contents: conversationHistory,
            config: {
              tools: [{ functionDeclarations: ANALYST_TOOLS }],
            },
          }),
          { operationName: 'AgenticAnalyst.generateContent' }
        );

        // Observability: record token usage from response
        try {
          const usage = (response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;
          this.obs.endGeneration(genId, {
            usage: usage ? {
              promptTokens: usage.promptTokenCount,
              completionTokens: usage.candidatesTokenCount,
              totalTokens: usage.totalTokenCount,
            } : undefined,
          });
        } catch { /* non-fatal */ }

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
        // End the generation with error status
        try { this.obs.endGeneration(`gen-analyst-cycle-${iteration}`, { level: 'ERROR', statusMessage: errorMessage }); } catch { /* non-fatal */ }

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
    // Load the comprehensive skill from file (includes task instructions and placeholders)
    const prompt = loadMedicalAnalysisSkill();
    return applyPatientContext(prompt, patientContext);
  }
}

/**
 * Apply patient context to a skill template.
 * Exported for testing the template substitution logic independently.
 */
export function applyPatientContext(prompt: string, patientContext?: string): string {
  if (patientContext) {
    // Remove the {{#if}} and {{/if}} markers, keep the content, substitute the variable
    return prompt
      .replace(/\{\{#if patient_question\}\}/g, '')
      .replace(/\{\{\/if\}\}/g, '')
      .replace(/\{\{patient_question\}\}/g, patientContext);
  } else {
    // Remove the entire conditional block if no patient context
    return prompt.replace(/\{\{#if patient_question\}\}[\s\S]*?\{\{\/if\}\}/g, '');
  }
}
