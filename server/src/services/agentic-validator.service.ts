/**
 * Agentic Validator Service
 *
 * A VERIFICATION-FOCUSED validator that checks structured_data.json
 * completeness against source data. Unlike the analyst (which explores),
 * the validator VERIFIES that data was captured correctly.
 *
 * Key design: Tools return SUMMARIES and VERIFICATION RESULTS, not full content.
 * This prevents payload bloat that caused socket termination errors.
 *
 * Verification-focused tools:
 * - verify_value_exists: COMBINED check - is value in source AND JSON? (PRIMARY TOOL)
 * - get_document_summary: Returns metadata + key values, NOT full content
 * - get_json_overview: Shows sections and sizes, NOT full JSON
 * - get_json_section_summary: Shows counts + preview, NOT full section
 * - compare_date_ranges: Compares source vs JSON timeline coverage
 * - find_missing_timeline_years: Finds gaps in timeline
 * - check_value_in_json: Checks if marker/value exists in JSON
 * - report_issue: Log a validation issue
 * - complete_validation: Signal validation complete
 *
 * Legacy tools (redirected):
 * - read_document → get_document_summary
 * - get_structured_json → get_json_overview / get_json_section_summary
 */

import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { REALM_CONFIG } from '../config.js';
import { withRetry, sleep } from '../common/index.js';
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

function loadValidatorSkill(): string {
  const skillPath = path.join(
    process.cwd(),
    '.gemini',
    'skills',
    'validator',
    'SKILL.md'
  );

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    // Extract content after frontmatter
    const match = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    return match ? match[1].trim() : content;
  } catch (error) {
    console.warn('[AgenticValidator] Could not load validator SKILL.md, using fallback');
    return 'You are a quality assurance specialist. Validate that structured_data.json contains all data from the source documents.';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ValidatorEvent {
  type: 'log' | 'tool_call' | 'thinking' | 'issue_found' | 'complete' | 'error';
  data: {
    message?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    issue?: ValidationIssue;
    iteration?: number;
  };
}

interface ValidationIssue {
  category: 'missing_data' | 'missing_timeline' | 'wrong_value' | 'missing_context' | 'inconsistency';
  severity: 'critical' | 'warning' | 'info';
  description: string;
  source_location?: string;
  json_location?: string;
}

interface DocumentSection {
  name: string;
  pageNumber?: number;
  content: string;
  startLine: number;
  endLine: number;
}

interface TimelineEvent {
  date: string;
  year: number;
  month?: number;
  day?: number;
  document: string;
  event: string;
  snippet: string;
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
  dateRange: DateRange | null;
  documentsByYear: Record<number, string[]>;
  timelineEvents: TimelineEvent[];
}

// ============================================================================
// Tool Definitions for Gemini Function Calling
// ============================================================================

const VALIDATOR_TOOLS = [
  // ============================================================================
  // Verification-Focused Tools (NOT exploration - validator verifies, not explores)
  // ============================================================================
  {
    name: 'list_documents',
    description: 'List all source documents with summary stats. Use this first to understand what data exists.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_document_summary',
    description: 'Get a SUMMARY of a document (metadata, key values, date range) - NOT full content. Use this instead of reading entire documents.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        document_name: {
          type: Type.STRING,
          description: 'The name of the document to summarize',
        },
      },
      required: ['document_name'],
    },
  },
  {
    name: 'search_data',
    description: 'Search source documents for a specific term. Returns matching lines only (not full documents). Use this to verify specific values exist.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search query - be specific (e.g., "glucose 105", "HbA1c")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'verify_value_exists',
    description: 'COMBINED CHECK: Verify a value exists in BOTH source data AND JSON, then compare units, reference ranges, and status for accuracy. Returns presence check AND field-level accuracy comparison. This is the primary verification tool.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        marker: {
          type: Type.STRING,
          description: 'The marker/test name (e.g., "Glucose", "HbA1c")',
        },
        expected_value: {
          type: Type.STRING,
          description: 'The expected value (optional - if omitted, just checks marker exists)',
        },
      },
      required: ['marker'],
    },
  },
  {
    name: 'get_date_range',
    description: 'Get the date range of source data. Compare this with JSON timeline to check completeness.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_documents_by_year',
    description: 'List source documents grouped by year.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'extract_timeline_events',
    description: 'Get ALL dated events from source documents.',
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
    description: 'Get history of a specific marker from source documents.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        marker: {
          type: Type.STRING,
          description: 'The lab marker to track',
        },
      },
      required: ['marker'],
    },
  },
  // ============================================================================
  // JSON Inspection Tools (validator-specific)
  // ============================================================================
  {
    name: 'get_json_overview',
    description: 'Get an OVERVIEW of structured_data.json showing what sections exist and their sizes. Use this first, then use check_value_in_json for specific checks.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_json_section_summary',
    description: 'Get a SUMMARY of a specific JSON section (counts, key items) - not full content. For arrays, shows count and first 3 items.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'The section to summarize (e.g., "timeline", "criticalFindings", "diagnoses")',
        },
      },
      required: ['section'],
    },
  },
  {
    name: 'compare_date_ranges',
    description: 'Compare date range in source vs JSON timeline. This is the key bidirectional check for timeline completeness.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'check_value_in_json',
    description: 'Check if a specific value appears anywhere in the structured JSON.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        marker: {
          type: Type.STRING,
          description: 'The marker/field name to search for',
        },
        value: {
          type: Type.STRING,
          description: 'The value to find (as string)',
        },
      },
      required: ['marker'],
    },
  },
  {
    name: 'find_missing_timeline_years',
    description: 'Find years that exist in source data but are missing from JSON timeline.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  // ============================================================================
  // Validation Tracking Tools
  // ============================================================================
  {
    name: 'report_issue',
    description: 'Report a validation issue found. Use this to log problems that need fixing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: 'Category: missing_data, missing_timeline, wrong_value, missing_context, inconsistency',
        },
        severity: {
          type: Type.STRING,
          description: 'Severity: critical, warning, info',
        },
        description: {
          type: Type.STRING,
          description: 'Detailed description of the issue',
        },
        source_location: {
          type: Type.STRING,
          description: 'Where the correct data is in source (optional)',
        },
        json_location: {
          type: Type.STRING,
          description: 'Where the problem is in JSON (optional)',
        },
      },
      required: ['category', 'severity', 'description'],
    },
  },
  {
    name: 'get_validation_summary',
    description: 'Get summary of all issues found so far.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'complete_validation',
    description: 'Signal that validation is complete. Call this when you have checked all required dimensions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: 'Status: pass, pass_with_warnings, needs_revision',
        },
        summary: {
          type: Type.STRING,
          description: 'Brief summary of validation results',
        },
      },
      required: ['status', 'summary'],
    },
  },
];

// ============================================================================
// Date Extraction (same as analyst)
// ============================================================================

function extractDatesFromText(text: string): Array<{ date: string; year: number; month?: number; day?: number; context: string }> {
  const dates: Array<{ date: string; year: number; month?: number; day?: number; context: string }> = [];
  const lines = text.split('\n');

  const monthMap: Record<string, number> = {
    'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
    'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
    'aug': 8, 'august': 8, 'sep': 9, 'september': 9, 'oct': 10, 'october': 10,
    'nov': 11, 'november': 11, 'dec': 12, 'december': 12
  };

  for (const line of lines) {
    let match;

    // ISO format: 2024-03-15
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
      if (year < 100) year += 2000;
      if (year >= 1990 && year <= 2030) {
        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        dates.push({ date: dateStr, year, month, day, context: line.trim().substring(0, 100) });
      }
    }

    // Written format: Month DD, YYYY
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

  // Deduplicate
  const seen = new Set<string>();
  return dates.filter(d => {
    const key = d.date + d.context;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseExtractedData(extractedContent: string): ParsedExtractedData {
  const sections: DocumentSection[] = [];
  const lines = extractedContent.split('\n');
  const sectionPattern = /^## \[([^\]]+)\](?:\s*-\s*Page\s*(\d+))?/;

  let currentSection: DocumentSection | null = null;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(sectionPattern);

    if (match) {
      if (currentSection) {
        currentSection.content = currentContent.join('\n').trim();
        currentSection.endLine = i - 1;
        sections.push(currentSection);
      }
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

  if (currentSection) {
    currentSection.content = currentContent.join('\n').trim();
    currentSection.endLine = lines.length - 1;
    sections.push(currentSection);
  }

  const documentNames = [...new Set(sections.map(s => s.name))];

  // Extract temporal data
  const timelineEvents: TimelineEvent[] = [];
  const documentsByYear: Record<number, string[]> = {};
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  for (const section of sections) {
    const dates = extractDatesFromText(section.content);
    for (const dateInfo of dates) {
      timelineEvents.push({
        date: dateInfo.date,
        year: dateInfo.year,
        month: dateInfo.month,
        day: dateInfo.day,
        document: section.name,
        event: section.name,
        snippet: dateInfo.context,
      });

      if (!documentsByYear[dateInfo.year]) documentsByYear[dateInfo.year] = [];
      if (!documentsByYear[dateInfo.year].includes(section.name)) {
        documentsByYear[dateInfo.year].push(section.name);
      }

      if (!earliestDate || dateInfo.date < earliestDate) earliestDate = dateInfo.date;
      if (!latestDate || dateInfo.date > latestDate) latestDate = dateInfo.date;
    }
  }

  timelineEvents.sort((a, b) => a.date.localeCompare(b.date));

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
// Tool Execution
// ============================================================================

export class ValidatorToolExecutor {
  private parsedData: ParsedExtractedData;
  private structuredJson: Record<string, unknown>;
  private issues: ValidationIssue[] = [];
  private verifiedMarkers: Set<string> = new Set();

  constructor(extractedContent: string, structuredJsonContent: string) {
    this.parsedData = parseExtractedData(extractedContent);
    try {
      this.structuredJson = JSON.parse(structuredJsonContent);
    } catch {
      this.structuredJson = {};
      console.warn('[AgenticValidator] Failed to parse structured JSON');
    }
  }

  execute(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      // Verification-focused source data tools
      case 'list_documents':
        return this.listDocuments();
      case 'get_document_summary':
        return this.getDocumentSummary(args.document_name as string);
      case 'search_data':
        return this.searchData(args.query as string);
      case 'verify_value_exists':
        return this.verifyValueExists(args.marker as string, args.expected_value as string | undefined);
      case 'get_date_range':
        return this.getDateRange();
      case 'list_documents_by_year':
        return this.listDocumentsByYear();
      case 'extract_timeline_events':
        return this.extractTimelineEvents(args.year as number | undefined);
      case 'get_value_history':
        return this.getValueHistory(args.marker as string);
      // JSON inspection tools (summary-focused)
      case 'get_json_overview':
        return this.getJsonOverview();
      case 'get_json_section_summary':
        return this.getJsonSectionSummary(args.section as string);
      case 'compare_date_ranges':
        return this.compareDateRanges();
      case 'check_value_in_json':
        return this.checkValueInJson(args.marker as string, args.value as string | undefined);
      case 'find_missing_timeline_years':
        return this.findMissingTimelineYears();
      // Validation tools
      case 'report_issue':
        return this.reportIssue(
          args.category as string,
          args.severity as string,
          args.description as string,
          args.source_location as string | undefined,
          args.json_location as string | undefined
        );
      case 'get_validation_summary':
        return this.getValidationSummary();
      case 'complete_validation':
        return this.completeValidation(args.status as string, args.summary as string);
      // Legacy tools (redirect to new tools)
      case 'read_document':
        return this.getDocumentSummary(args.document_name as string);
      case 'get_structured_json':
        return args.section ? this.getJsonSectionSummary(args.section as string) : this.getJsonOverview();
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  // ============================================================================
  // Source Data Tools (same as analyst)
  // ============================================================================

  private listDocuments(): string {
    const docSummary = this.parsedData.documentNames.map(name => {
      const sections = this.parsedData.sections.filter(s => s.name === name);
      const totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);
      return `- ${name} (${sections.length} section(s), ~${Math.round(totalChars / 1000)}K chars)`;
    });
    return `# Source Documents\n\nTotal: ${this.parsedData.totalSections} sections from ${this.parsedData.documentNames.length} documents\n\n${docSummary.join('\n')}`;
  }

  /**
   * Get a SUMMARY of a document - metadata, key values extracted, NOT full content.
   * This is verification-focused: tells you what's IN the document without returning everything.
   */
  private getDocumentSummary(documentName: string): string {
    const sections = this.parsedData.sections.filter(
      s => s.name.toLowerCase().includes(documentName.toLowerCase())
    );
    if (sections.length === 0) {
      return `Document not found: "${documentName}". Use list_documents() to see available documents.`;
    }

    const totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);

    // Extract key values (numbers with context)
    const keyValues: string[] = [];
    const valuePattern = /(?:^|\s)([A-Za-z][A-Za-z\s]{2,30})[\s:]+(\d+\.?\d*)\s*(mg\/dL|mmol\/L|%|g\/dL|U\/L|ng\/mL|pg\/mL|mIU\/L|fL|K\/uL|M\/uL)?/gi;

    for (const section of sections) {
      const matches = section.content.matchAll(valuePattern);
      for (const match of matches) {
        const name = match[1].trim();
        const value = match[2];
        const unit = match[3] || '';
        if (name.length > 2 && name.length < 30) {
          keyValues.push(`${name}: ${value}${unit ? ' ' + unit : ''}`);
        }
      }
    }

    // Dedupe
    const uniqueValues = [...new Set(keyValues)];

    // Extract dates mentioned
    const dates = this.parsedData.timelineEvents
      .filter(e => sections.some(s => s.name === e.document))
      .map(e => e.date);

    return `# Document Summary: ${documentName}

**Sections Found:** ${sections.length}
**Total Size:** ~${Math.round(totalChars / 1024)}KB
**Dates Mentioned:** ${dates.length > 0 ? dates.join(', ') : 'None found'}

## Key Values Extracted (${uniqueValues.length} found)
${uniqueValues.length > 0 ? uniqueValues.map(v => `- ${v}`).join('\n') : 'No numeric values found'}

**To verify specific values:** Use \`search_data("marker name")\` or \`verify_value_exists("marker", "value")\``;
  }

  /**
   * Parse a pipe-delimited source line into structured fields.
   * Handles formats like: | Marker | Value *H | RefRange | Unit |
   */
  private parseSourceLabLine(line: string): {
    marker: string; value: string; unit: string;
    refRange: string; status: string;
  } | null {
    // Split by pipe delimiter
    const parts = line.split('|').map(p => p.trim()).filter(p => p.length > 0);
    if (parts.length < 2) return null;

    const marker = parts[0];

    // Extract value and status flag from second column
    let valueStr = parts[1] || '';
    let status = '';
    const flagMatch = valueStr.match(/\*{1,2}([HL])\b/i);
    if (flagMatch) {
      status = flagMatch[1].toUpperCase() === 'H' ? 'high' : 'low';
      valueStr = valueStr.replace(/\s*\*{1,2}[HL]\b/i, '').trim();
    }

    // Remaining columns: identify which is unit and which is reference range
    let unit = '';
    let refRange = '';

    for (let i = 2; i < parts.length; i++) {
      const col = parts[i];
      // Reference range heuristics: contains a range pattern (num - num) or comparison (< num, > num)
      const isRange = /\d+\.?\d*\s*[-–]\s*\d+\.?\d*/.test(col) || /^[<>]\s*\d+/.test(col) || /\(\s*\d+/.test(col);
      // Unit heuristics: contains / (like mg/dL, mmol/L) or is a known unit pattern, and is short
      const isUnit = /[a-zA-Z]\/[a-zA-Z]/.test(col) || /^(%|Ratio|RATIO|Pos\/Neg)$/i.test(col);

      if (isRange && !refRange) {
        // Clean up range: remove parentheses, brackets
        refRange = col.replace(/[()[\]]/g, '').trim();
      } else if (isUnit && !unit) {
        unit = col;
      } else if (!refRange && !isUnit && col.match(/\d/)) {
        // Fallback: if it has numbers and no unit assigned yet, probably range
        refRange = col.replace(/[()[\]]/g, '').trim();
      } else if (!unit && col.length < 20 && !col.match(/^\d+$/)) {
        // Fallback: short non-numeric string is likely unit
        unit = col;
      }
    }

    // Only return if we got at least a value
    if (!valueStr) return null;

    return { marker, value: valueStr, unit, refRange, status };
  }

  /**
   * Extract structured value details from JSON sections (criticalFindings, trends).
   */
  private extractJsonValueDetails(marker: string): {
    value: string; unit: string;
    refMin: string; refMax: string; status: string;
    location: string;
  } | null {
    const markerLower = marker.toLowerCase();
    const sections = ['criticalFindings', 'trends'] as const;

    for (const section of sections) {
      const arr = this.structuredJson[section];
      if (!Array.isArray(arr)) continue;

      for (const item of arr) {
        const itemMarker = (item as Record<string, unknown>).marker;
        if (typeof itemMarker !== 'string') continue;
        if (!itemMarker.toLowerCase().includes(markerLower) && !markerLower.includes(itemMarker.toLowerCase())) continue;

        const value = String((item as Record<string, unknown>).value ?? '');
        const unit = String((item as Record<string, unknown>).unit ?? '');
        const status = String((item as Record<string, unknown>).status ?? '');
        const refRange = (item as Record<string, unknown>).referenceRange as Record<string, unknown> | undefined;

        let refMin = '';
        let refMax = '';
        if (refRange && typeof refRange === 'object') {
          refMin = String(refRange.min ?? refRange.low ?? '');
          refMax = String(refRange.max ?? refRange.high ?? '');
        } else if (typeof (item as Record<string, unknown>).referenceRange === 'string') {
          // Parse string range like "150-400"
          const rangeStr = String((item as Record<string, unknown>).referenceRange);
          const rangeMatch = rangeStr.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
          if (rangeMatch) {
            refMin = rangeMatch[1];
            refMax = rangeMatch[2];
          }
        }

        return { value, unit, refMin, refMax, status, location: section };
      }
    }
    return null;
  }

  /**
   * Normalize a unit string for comparison (case-insensitive, common equivalents).
   */
  private normalizeUnit(unit: string): string {
    return unit.trim().toLowerCase()
      .replace(/µ/g, 'u')   // µmol → umol
      .replace(/\s+/g, ''); // remove spaces
  }

  /**
   * COMBINED verification: Check if a value exists in BOTH source AND JSON.
   * Also compares units, reference ranges, and status for accuracy.
   * This is THE primary verification tool - single call to verify correctness.
   */
  private verifyValueExists(marker: string, expectedValue?: string): string {
    const markerLower = marker.toLowerCase();

    // Search in source data
    const sourceMatches: string[] = [];
    for (const section of this.parsedData.sections) {
      const lines = section.content.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(markerLower)) {
          sourceMatches.push(`[${section.name}] ${line.trim().substring(0, 150)}`);
        }
      }
    }

    // Search in JSON
    const jsonMatches: string[] = [];
    const searchJson = (obj: unknown, path: string = ''): void => {
      if (obj === null || obj === undefined) return;
      if (typeof obj === 'string') {
        if (obj.toLowerCase().includes(markerLower)) {
          jsonMatches.push(`${path}: "${obj.substring(0, 100)}"`);
        }
      } else if (typeof obj === 'number') {
        if (expectedValue && obj.toString() === expectedValue) {
          jsonMatches.push(`${path}: ${obj}`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, i) => searchJson(item, `${path}[${i}]`));
      } else if (typeof obj === 'object') {
        for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
          if (key.toLowerCase().includes(markerLower)) {
            jsonMatches.push(`${path}.${key}: ${JSON.stringify(val).substring(0, 100)}`);
          } else {
            searchJson(val, path ? `${path}.${key}` : key);
          }
        }
      }
    };
    searchJson(this.structuredJson);

    const inSource = sourceMatches.length > 0;
    const inJson = jsonMatches.length > 0;

    let status: string;
    if (inSource && inJson) {
      status = '✅ VERIFIED - Value exists in both source and JSON';
      this.verifiedMarkers.add(marker);
    } else if (inSource && !inJson) {
      status = '⚠️ MISSING FROM JSON - Value in source but NOT in JSON (potential data loss)';
    } else if (!inSource && inJson) {
      status = '⚠️ NOT IN SOURCE - Value in JSON but NOT in source (potential fabrication)';
    } else {
      status = '❌ NOT FOUND - Value not found in either source or JSON';
    }

    // Field accuracy comparison (when value exists in both)
    let accuracySection = '';
    if (inSource && inJson) {
      // Parse source lines for structured details
      const sourceRawLines: string[] = [];
      for (const section of this.parsedData.sections) {
        const lines = section.content.split('\n');
        for (const line of lines) {
          if (line.toLowerCase().includes(markerLower) && line.includes('|')) {
            sourceRawLines.push(line.trim());
          }
        }
      }

      const sourceParsed = sourceRawLines
        .map(line => this.parseSourceLabLine(line))
        .filter((p): p is NonNullable<ReturnType<typeof this.parseSourceLabLine>> => p !== null);

      const jsonDetails = this.extractJsonValueDetails(marker);

      if (sourceParsed.length > 0 && jsonDetails) {
        const src = sourceParsed[0]; // Use best match
        const checks: string[] = [];
        let hasMismatch = false;

        // Unit comparison
        if (src.unit && jsonDetails.unit) {
          const srcNorm = this.normalizeUnit(src.unit);
          const jsonNorm = this.normalizeUnit(jsonDetails.unit);
          if (srcNorm === jsonNorm) {
            checks.push(`- Unit: MATCH (${src.unit})`);
          } else {
            checks.push(`- Unit: MISMATCH — Source: "${src.unit}", JSON: "${jsonDetails.unit}"`);
            hasMismatch = true;
          }
        } else if (src.unit || jsonDetails.unit) {
          checks.push(`- Unit: Source="${src.unit || '(none)'}", JSON="${jsonDetails.unit || '(none)'}"`);
        }

        // Reference range comparison
        if (src.refRange && (jsonDetails.refMin || jsonDetails.refMax)) {
          const srcRangeMatch = src.refRange.match(/([\d,.]+)\s*[-–]\s*([\d,.]+)/);
          if (srcRangeMatch) {
            const srcMin = parseFloat(srcRangeMatch[1].replace(/,/g, ''));
            const srcMax = parseFloat(srcRangeMatch[2].replace(/,/g, ''));
            const jsonMin = parseFloat(jsonDetails.refMin);
            const jsonMax = parseFloat(jsonDetails.refMax);

            const minMatch = !isNaN(srcMin) && !isNaN(jsonMin) && Math.abs(srcMin - jsonMin) < 0.1;
            const maxMatch = !isNaN(srcMax) && !isNaN(jsonMax) && Math.abs(srcMax - jsonMax) < 0.1;

            if (minMatch && maxMatch) {
              checks.push(`- Reference Range: MATCH (${src.refRange})`);
            } else {
              checks.push(`- Reference Range: MISMATCH — Source: ${srcRangeMatch[1]}-${srcRangeMatch[2]}, JSON: ${jsonDetails.refMin}-${jsonDetails.refMax}`);
              hasMismatch = true;
            }
          } else {
            checks.push(`- Reference Range: Source="${src.refRange}", JSON="${jsonDetails.refMin}-${jsonDetails.refMax}"`);
          }
        }

        // Status comparison
        if (src.status && jsonDetails.status) {
          const srcStatus = src.status.toLowerCase();
          const jsonStatus = jsonDetails.status.toLowerCase();
          // Map "critical" to "high" for comparison purposes
          const jsonStatusNorm = jsonStatus === 'critical' ? 'high' : jsonStatus;
          if (srcStatus === jsonStatusNorm || srcStatus === jsonStatus) {
            checks.push(`- Status: MATCH (source="${src.status}", json="${jsonDetails.status}")`);
          } else {
            checks.push(`- Status: MISMATCH — Source: "${src.status}", JSON: "${jsonDetails.status}"`);
            hasMismatch = true;
          }
        }

        if (checks.length > 0) {
          accuracySection = `\n\n## Field Accuracy (${jsonDetails.location})\n${checks.join('\n')}`;
          if (hasMismatch) {
            accuracySection += `\n\nACTION REQUIRED: Unit, reference range, or status in JSON does not match source. Use report_issue() to flag accuracy errors.`;
          }
        }
      }
    }

    return `# Verification: "${marker}"${expectedValue ? ` = ${expectedValue}` : ''}

**Status:** ${status}

## Source Data (${sourceMatches.length} matches)
${sourceMatches.map(m => `- ${m}`).join('\n') || 'No matches found'}

## JSON Data (${jsonMatches.length} matches)
${jsonMatches.map(m => `- ${m}`).join('\n') || 'No matches found'}${accuracySection}`;
  }

  private searchData(query: string): string {
    const results: { section: string; matches: string[] }[] = [];
    const queryLower = query.toLowerCase();

    for (const section of this.parsedData.sections) {
      const lines = section.content.split('\n');
      const matches = lines.filter(l => l.toLowerCase().includes(queryLower));
      if (matches.length > 0) {
        results.push({ section: section.name, matches });
      }
    }

    if (results.length === 0) {
      return `No matches found for "${query}"`;
    }

    return `# Search Results for "${query}"\n\n${results.map(r =>
      `### ${r.section}\n${r.matches.join('\n')}`
    ).join('\n\n')}`;
  }

  private getDateRange(): string {
    const { dateRange, timelineEvents } = this.parsedData;
    if (!dateRange) {
      return `No dates found in source documents.`;
    }

    const yearsWithData = Object.keys(this.parsedData.documentsByYear).map(Number).sort((a, b) => a - b);
    return `# Source Data Date Range

**Earliest:** ${dateRange.earliest}
**Latest:** ${dateRange.latest}
**Span:** ${dateRange.years} years
**Timeline Events:** ${timelineEvents.length}
**Years with Data:** ${yearsWithData.join(', ')}`;
  }

  private listDocumentsByYear(): string {
    const { documentsByYear } = this.parsedData;
    const years = Object.keys(documentsByYear).map(Number).sort((a, b) => a - b);
    return `# Source Documents by Year\n\n${years.map(y =>
      `## ${y}\n${documentsByYear[y].map(d => `- ${d}`).join('\n')}`
    ).join('\n\n')}`;
  }

  private extractTimelineEvents(year?: number): string {
    let events = this.parsedData.timelineEvents;
    if (year) events = events.filter(e => e.year === year);

    if (events.length === 0) {
      return year ? `No events found for year ${year}.` : `No timeline events found.`;
    }

    const byYear: Record<number, TimelineEvent[]> = {};
    for (const e of events) {
      if (!byYear[e.year]) byYear[e.year] = [];
      byYear[e.year].push(e);
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    return `# Source Timeline Events\n\n${years.map(y => {
      return `## ${y} (${byYear[y].length} events)\n${byYear[y].map(e =>
        `- ${e.date}: ${e.snippet.substring(0, 60)}...`
      ).join('\n')}`;
    }).join('\n\n')}`;
  }

  private getValueHistory(marker: string): string {
    const results: Array<{ date: string; value: string; document: string }> = [];
    const markerLower = marker.toLowerCase();

    for (const section of this.parsedData.sections) {
      const lines = section.content.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(markerLower)) {
          const valueMatch = line.match(/(\d+\.?\d*)/);
          if (valueMatch) {
            const dates = extractDatesFromText(section.content);
            const date = dates.length > 0 ? dates[0].date : 'Unknown';
            results.push({ date, value: valueMatch[1], document: section.name });
          }
        }
      }
    }

    if (results.length === 0) {
      return `No values found for "${marker}" in source.`;
    }

    results.sort((a, b) => a.date.localeCompare(b.date));
    return `# Source Value History: ${marker}\n\n${results.map(r =>
      `- ${r.date}: ${r.value} (${r.document})`
    ).join('\n')}`;
  }

  // ============================================================================
  // JSON Inspection Tools (summary-focused, not full content)
  // ============================================================================

  /**
   * Get an OVERVIEW of the JSON structure - what sections exist and their sizes.
   * Does NOT return actual content - just metadata for planning verification.
   */
  private getJsonOverview(): string {
    const sections = Object.keys(this.structuredJson);

    const summary = sections.map(key => {
      const value = this.structuredJson[key];
      let info: string;

      if (Array.isArray(value)) {
        info = `array[${value.length} items]`;
      } else if (value === null) {
        info = 'null';
      } else if (typeof value === 'object') {
        const subKeys = Object.keys(value as Record<string, unknown>);
        info = `object{${subKeys.slice(0, 3).join(', ')}${subKeys.length > 3 ? '...' : ''}}`;
      } else {
        info = typeof value;
      }

      return `- **${key}**: ${info}`;
    });

    // Check for key sections
    const hasTimeline = 'timeline' in this.structuredJson;
    const hasCritical = 'criticalFindings' in this.structuredJson;
    const hasExecutive = 'executiveSummary' in this.structuredJson;

    return `# JSON Structure Overview

**Total Sections:** ${sections.length}
**Has Timeline:** ${hasTimeline ? 'Yes' : 'NO - potential issue'}
**Has Critical Findings:** ${hasCritical ? 'Yes' : 'NO - potential issue'}
**Has Executive Summary:** ${hasExecutive ? 'Yes' : 'NO - potential issue'}

## Sections
${summary.join('\n')}

**Next steps:** Use \`get_json_section_summary("section")\` or \`check_value_in_json("marker")\` to verify specific content.`;
  }

  /**
   * Get a SUMMARY of a specific JSON section - counts, key items, NOT full content.
   */
  private getJsonSectionSummary(section: string): string {
    const value = this.structuredJson[section];
    if (value === undefined) {
      return `Section "${section}" not found. Available: ${Object.keys(this.structuredJson).join(', ')}`;
    }

    if (Array.isArray(value)) {
      // For arrays: show count and first 2-3 items as preview
      const preview = value.slice(0, 2);
      const previewStr = JSON.stringify(preview, null, 2);
      const truncatedPreview = previewStr.length > 2000 ? previewStr.substring(0, 2000) + '...' : previewStr;

      return `# JSON Section: ${section}

**Type:** Array
**Count:** ${value.length} items

## Preview (first ${Math.min(2, value.length)} items)
\`\`\`json
${truncatedPreview}
\`\`\`

**To verify specific items:** Use \`check_value_in_json("marker", "value")\``;

    } else if (typeof value === 'object' && value !== null) {
      // For objects: show keys and summarize
      const keys = Object.keys(value as Record<string, unknown>);
      const keysSummary = keys.map(k => {
        const v = (value as Record<string, unknown>)[k];
        if (Array.isArray(v)) return `- ${k}: array[${v.length}]`;
        if (typeof v === 'object') return `- ${k}: object`;
        return `- ${k}: ${String(v).substring(0, 50)}`;
      });

      return `# JSON Section: ${section}

**Type:** Object
**Keys:** ${keys.length}

## Structure
${keysSummary.slice(0, 15).join('\n')}${keys.length > 15 ? '\n... and more' : ''}

**To verify values:** Use \`check_value_in_json("marker")\``;

    } else {
      return `# JSON Section: ${section}

**Type:** ${typeof value}
**Value:** ${String(value).substring(0, 500)}`;
    }
  }

  private compareDateRanges(): string {
    const sourceRange = this.parsedData.dateRange;
    if (!sourceRange) {
      return `Cannot compare: No dates found in source documents.`;
    }

    // Extract timeline from JSON
    const jsonTimeline = this.structuredJson['timeline'] as Array<{ date?: string }> || [];
    const jsonDates = jsonTimeline
      .map(e => e.date)
      .filter(Boolean)
      .sort() as string[];

    const jsonYears = new Set(jsonDates.map(d => parseInt(d.substring(0, 4), 10)));
    const sourceYears = Object.keys(this.parsedData.documentsByYear).map(Number);

    const missingYears = sourceYears.filter(y => !jsonYears.has(y));

    const jsonEarliest = jsonDates.length > 0 ? jsonDates[0] : 'N/A';
    const jsonLatest = jsonDates.length > 0 ? jsonDates[jsonDates.length - 1] : 'N/A';

    let status = 'PASS';
    if (missingYears.length > sourceYears.length * 0.5) {
      status = 'CRITICAL - More than 50% of years missing';
    } else if (missingYears.length > 0) {
      status = 'WARNING - Some years missing';
    }

    return `# Date Range Comparison

## Source Data
- **Range:** ${sourceRange.earliest} to ${sourceRange.latest}
- **Span:** ${sourceRange.years} years
- **Years with data:** ${sourceYears.sort((a, b) => a - b).join(', ')}
- **Total events:** ${this.parsedData.timelineEvents.length}

## JSON Timeline
- **Range:** ${jsonEarliest} to ${jsonLatest}
- **Entries:** ${jsonTimeline.length}
- **Years covered:** ${[...jsonYears].sort((a, b) => a - b).join(', ') || 'None'}

## Comparison
- **Status:** ${status}
- **Missing Years:** ${missingYears.length > 0 ? missingYears.sort((a, b) => a - b).join(', ') : 'None'}
- **Coverage:** ${Math.round((sourceYears.length - missingYears.length) / sourceYears.length * 100)}%

${missingYears.length > 0 ? `\n**ACTION REQUIRED:** JSON timeline is missing ${missingYears.length} years of data. Use report_issue() to flag this.` : ''}`;
  }

  private checkValueInJson(marker: string, value?: string): string {
    const jsonStr = JSON.stringify(this.structuredJson).toLowerCase();
    const markerLower = marker.toLowerCase();

    const markerFound = jsonStr.includes(markerLower);
    const valueFound = value ? jsonStr.includes(value.toLowerCase()) : null;

    const locations: string[] = [];

    // Search for marker in common locations
    const checkLocations = ['criticalFindings', 'trends', 'keyBiomarkers', 'timeline', 'diagnoses'];
    for (const loc of checkLocations) {
      const section = this.structuredJson[loc];
      if (section && JSON.stringify(section).toLowerCase().includes(markerLower)) {
        locations.push(loc);
      }
    }

    return `# Check Value in JSON

**Marker:** ${marker}
**Value:** ${value || '(not specified)'}

**Marker Found:** ${markerFound ? 'YES' : 'NO'}
${value ? `**Value Found:** ${valueFound ? 'YES' : 'NO'}` : ''}
**Locations:** ${locations.length > 0 ? locations.join(', ') : 'Not found in standard locations'}

${!markerFound ? `\n**ACTION:** Marker "${marker}" not found in JSON. Use report_issue() if this should be present.` : ''}`;
  }

  private findMissingTimelineYears(): string {
    const sourceYears = Object.keys(this.parsedData.documentsByYear).map(Number).sort((a, b) => a - b);

    const jsonTimeline = this.structuredJson['timeline'] as Array<{ date?: string }> || [];
    const jsonYears = new Set(jsonTimeline.map(e => e.date ? parseInt(e.date.substring(0, 4), 10) : null).filter(Boolean));

    const missingYears = sourceYears.filter(y => !jsonYears.has(y));
    const coveredYears = sourceYears.filter(y => jsonYears.has(y));

    if (missingYears.length === 0) {
      return `# Timeline Year Coverage\n\n**Status:** COMPLETE - All ${sourceYears.length} years with source data are represented in JSON timeline.`;
    }

    const missingDetails = missingYears.map(y => {
      const docs = this.parsedData.documentsByYear[y] || [];
      const events = this.parsedData.timelineEvents.filter(e => e.year === y).length;
      return `- **${y}**: ${docs.length} document(s), ${events} event(s) - Documents: ${docs.slice(0, 3).join(', ')}${docs.length > 3 ? '...' : ''}`;
    });

    return `# Missing Timeline Years

**Source has ${sourceYears.length} years of data.**
**JSON timeline covers ${coveredYears.length} years.**
**Missing ${missingYears.length} years (${Math.round(missingYears.length / sourceYears.length * 100)}% gap).**

## Missing Years Detail
${missingDetails.join('\n')}

## Covered Years
${coveredYears.join(', ')}

---

**ACTION REQUIRED:** Use report_issue() to flag this timeline incompleteness.`;
  }

  // ============================================================================
  // Validation Tools
  // ============================================================================

  private reportIssue(
    category: string,
    severity: string,
    description: string,
    sourceLocation?: string,
    jsonLocation?: string
  ): string {
    const issue: ValidationIssue = {
      category: category as ValidationIssue['category'],
      severity: severity as ValidationIssue['severity'],
      description,
      source_location: sourceLocation,
      json_location: jsonLocation,
    };
    this.issues.push(issue);

    return `Issue logged: [${severity.toUpperCase()}] ${category} - ${description}

Total issues: ${this.issues.length} (${this.issues.filter(i => i.severity === 'critical').length} critical, ${this.issues.filter(i => i.severity === 'warning').length} warnings)`;
  }

  private getValidationSummary(): string {
    const critical = this.issues.filter(i => i.severity === 'critical');
    const warnings = this.issues.filter(i => i.severity === 'warning');
    const info = this.issues.filter(i => i.severity === 'info');

    if (this.issues.length === 0) {
      return `# Validation Summary\n\nNo issues found yet. Continue validation checks.`;
    }

    const issueList = this.issues.map((issue, i) =>
      `${i + 1}. [${issue.severity.toUpperCase()}] **${issue.category}**: ${issue.description}`
    ).join('\n');

    return `# Validation Summary

**Total Issues:** ${this.issues.length}
- Critical: ${critical.length}
- Warnings: ${warnings.length}
- Info: ${info.length}

## All Issues
${issueList}`;
  }

  private completeValidation(status: string, summary: string): string {
    const critical = this.issues.filter(i => i.severity === 'critical').length;
    const warnings = this.issues.filter(i => i.severity === 'warning').length;

    return `VALIDATION_COMPLETE|${status}|${critical}|${warnings}|${summary}`;
  }

  getIssues(): ValidationIssue[] {
    return this.issues;
  }

  getVerifiedMarkers(): string[] {
    return [...this.verifiedMarkers];
  }
}

// ============================================================================
// Agentic Validator
// ============================================================================

export class AgenticValidator {
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
    console.log(`[AgenticValidator] Initialized with model: ${this.model}`);
  }

  /**
   * Run agentic validation
   */
  async *validate(
    extractedContent: string,
    structuredJsonContent: string,
    patientContext?: string,
    maxIterations: number = 15,
    previouslyRaisedIssues: Array<{ category: string; severity: string; description: string }> = [],
    previouslyVerifiedOK: string[] = []
  ): AsyncGenerator<ValidatorEvent, { status: string; issues: ValidationIssue[]; summary: string; verifiedMarkers: string[] }, unknown> {
    const toolExecutor = new ValidatorToolExecutor(extractedContent, structuredJsonContent);

    yield {
      type: 'log',
      data: { message: 'Starting agentic validation...' },
    };

    const systemPrompt = this.buildSystemPrompt(patientContext, previouslyRaisedIssues, previouslyVerifiedOK);

    let conversationHistory: Array<{
      role: string;
      parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: unknown }>;
    }> = [
      { role: 'user', parts: [{ text: systemPrompt }] },
    ];

    let iteration = 0;
    let validationComplete = false;
    let finalStatus = 'needs_revision';
    let finalSummary = '';
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 1; // Skip after first failure (which already had 3 retry attempts)

    while (!validationComplete && iteration < maxIterations) {
      iteration++;

      // Add delay between LLM calls to prevent rate limiting (skip first iteration)
      if (iteration > 1) {
        const delayMs = REALM_CONFIG.throttle.llm.delayBetweenRequestsMs;
        await sleep(delayMs);
      }

      yield {
        type: 'log',
        data: { message: `Validation cycle ${iteration}/${maxIterations}...`, iteration },
      };

      // Compress conversation history if it has grown too large
      const compression = await this.compressionService.compressIfNeeded(
        conversationHistory,
        {
          phase: 'validator',
          externalState: toolExecutor.getIssues().length > 0
            ? `## Tracked Issues (stored externally)\n${toolExecutor.getIssues().map((issue, i) =>
                `${i + 1}. [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}`
              ).join('\n')}`
            : undefined,
        },
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
        const genId = `gen-validator-cycle-${iteration}`;
        try { this.obs.startGeneration(genId, { name: `cycle-${iteration}`, traceId: this.traceId, parentSpanId: this.parentSpanId, model: this.model }); } catch { /* non-fatal */ }

        // Use limited retries (3 total attempts) to fail fast and skip validation
        const response = await withRetry(
          () => this.genai.models.generateContent({
            model: this.model,
            contents: conversationHistory,
            config: {
              tools: [{ functionDeclarations: VALIDATOR_TOOLS }],
            },
          }),
          {
            maxRetries: 2, // 3 total attempts (much less than default 8)
            baseMultiplier: 5,
            minWait: 0.5,
            operationName: 'AgenticValidator.generateContent'
          }
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

        // Reset failure counter on successful response
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
          // Track function responses with their thoughtSignatures (required for thinking mode)
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

            yield {
              type: 'tool_call',
              data: { toolName, toolArgs, iteration },
            };

            const result = toolExecutor.execute(toolName, toolArgs);

            // Check if validation is complete
            if (result.startsWith('VALIDATION_COMPLETE|')) {
              validationComplete = true;
              const resultParts = result.split('|');
              finalStatus = resultParts[1];
              finalSummary = resultParts[4];
              yield {
                type: 'complete',
                data: { message: `Validation complete: ${finalStatus}`, iteration },
              };
              break;
            }

            // Check if issue was reported
            if (toolName === 'report_issue') {
              const issues = toolExecutor.getIssues();
              const latestIssue = issues[issues.length - 1];
              yield {
                type: 'issue_found',
                data: { issue: latestIssue, iteration },
              };
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
          }

          if (!validationComplete) {
            // Include thoughtSignature if present (required for thinking mode)
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
            yield {
              type: 'thinking',
              data: { message: text.substring(0, 300), iteration },
            };

            conversationHistory.push({ role: 'model', parts: [{ text }] });
            conversationHistory.push({
              role: 'user',
              parts: [{ text: 'Continue validation. Use the tools to check more aspects, or call complete_validation when done.' }],
            });
          }
        }
      } catch (error) {
        consecutiveFailures++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        // End the generation with error status
        try { this.obs.endGeneration(`gen-validator-cycle-${iteration}`, { level: 'ERROR', statusMessage: errorMessage }); } catch { /* non-fatal */ }

        yield {
          type: 'error',
          data: { message: `Error in iteration ${iteration} (failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${errorMessage}` },
        };

        // Skip validation after too many consecutive failures
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          yield {
            type: 'log',
            data: { message: `Skipping validation after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Proceeding with current data.` },
          };
          finalStatus = 'skipped';
          finalSummary = `Validation skipped due to ${MAX_CONSECUTIVE_FAILURES} consecutive API failures`;
          break;
        }

        conversationHistory.push({
          role: 'user',
          parts: [{ text: 'There was an error. Please continue validation.' }],
        });
      }
    }

    if (!validationComplete && finalStatus !== 'skipped') {
      yield {
        type: 'log',
        data: { message: `Max iterations reached. Finalizing validation...` },
      };
    }

    const issues = toolExecutor.getIssues();

    return {
      status: finalStatus,
      issues,
      summary: finalSummary || `Validation completed with ${issues.length} issues`,
      verifiedMarkers: toolExecutor.getVerifiedMarkers(),
    };
  }

  private buildSystemPrompt(patientContext?: string, previouslyRaisedIssues: Array<{ category: string; severity: string; description: string }> = [], previouslyVerifiedOK: string[] = []): string {
    let prompt = loadValidatorSkill();

    // Add agentic instructions with verification-focused workflow
    prompt = `${prompt}

---

## Agentic Validation Workflow

You are a VERIFICATION-FOCUSED validator. Your job is to VERIFY that data was captured correctly, NOT to explore or read entire documents.

### CRITICAL: Use Efficient Verification Tools

**DO NOT** read entire documents or get full JSON content. This causes memory issues.

**Instead, use these efficient verification tools:**

| Task | Use This Tool | NOT This |
|------|--------------|----------|
| Verify a value + accuracy | \`verify_value_exists("marker", "value")\` | Reading full documents |
| Check document contents | \`get_document_summary("doc")\` | \`read_document\` (deprecated) |
| See JSON structure | \`get_json_overview()\` | \`get_structured_json\` (deprecated) |
| Check specific JSON section | \`get_json_section_summary("section")\` | Getting full JSON |
| Find specific values | \`search_data("query")\` | Reading everything |

### Verification Workflow (Efficient)

1. **Timeline Check** (2 calls max)
   - \`compare_date_ranges()\` - compares source vs JSON automatically
   - If gaps found: \`find_missing_timeline_years()\`
   - \`report_issue()\` for any gaps

2. **Critical Values Check** (use verify_value_exists)
   - \`get_json_section_summary("criticalFindings")\` - see what's captured
   - For each key value: \`verify_value_exists("marker", "expected_value")\`
   - This does a COMBINED check of source AND JSON in ONE call
   - CHECK the "Field Accuracy" section in the response — if units or reference ranges MISMATCH, use \`report_issue()\` to flag accuracy errors
   - \`report_issue()\` for missing values AND for unit/range mismatches

3. **Structure Check**
   - \`get_json_overview()\` - see what sections exist
   - \`get_json_section_summary("timeline")\` - check timeline has entries
   - Verify key sections are populated

4. **Complete Validation**
   - \`get_validation_summary()\` to review all issues
   - \`complete_validation(status, summary)\`:
     - "pass" if no critical issues
     - "pass_with_warnings" if only warnings
     - "needs_revision" if critical issues exist

### Key Principles

- **Verify, don't explore**: You're checking if data made it to JSON, not discovering what's in documents
- **Combined checks**: \`verify_value_exists()\` checks BOTH source AND JSON in one call, AND compares units/reference ranges for accuracy
- **Summaries only**: Use \`get_document_summary()\` and \`get_json_section_summary()\`, never full content
- **Be targeted**: Search for specific values, don't read everything

${previouslyRaisedIssues.length > 0 ? `### Previously Raised Issues (DO NOT RE-FLAG)

The following issues were already raised in previous validation cycles and corrections were attempted.
Do NOT report these issues again. Focus ONLY on finding NEW issues not already covered below.

${previouslyRaisedIssues.map(i => `- [${i.severity.toUpperCase()}] ${i.category}: ${i.description}`).join('\n')}

` : ''}${previouslyVerifiedOK.length > 0 ? `### Already Verified Correct (SKIP THESE)

The following markers were confirmed present and accurate in the previous validation cycle.
Do NOT re-check these — spend your iterations on unverified markers and new checks only.

${previouslyVerifiedOK.map(m => `- ${m}`).join('\n')}

` : ''}${patientContext ? `\n### Patient Context\n${patientContext}\n` : ''}

**START with \`compare_date_ranges()\` then \`get_json_overview()\`.**`;

    return prompt;
  }
}
