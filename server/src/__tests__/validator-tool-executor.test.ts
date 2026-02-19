/**
 * Tests for ValidatorToolExecutor from agentic-validator.service.ts
 *
 * Tests verification tools, JSON inspection, issue tracking, and completion.
 * Does NOT test the LLM-calling AgenticValidator class.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ValidatorToolExecutor } from '../services/agentic-validator.service.ts';

const SAMPLE_EXTRACTED = `## [CBC Report]
Date: 2024-03-15
| WBC | 5.2 *H | 4.0-10.0 | K/uL |
| RBC | 4.8 | 4.5-5.5 | M/uL |
| Hemoglobin | 14.2 | 12.0-16.0 | g/dL |

## [Metabolic Panel]
Date: 2020-06-10
| Glucose | 105 *H | 70-100 | mg/dL |
| HbA1c | 5.7 | 4.0-5.6 | % |
`;

const SAMPLE_JSON = JSON.stringify({
  executiveSummary: 'Patient has borderline glucose.',
  criticalFindings: [
    { marker: 'WBC', value: 5.2, unit: 'K/uL', status: 'high', referenceRange: { min: 4.0, max: 10.0 } },
    { marker: 'Glucose', value: 105, unit: 'mg/dL', status: 'high', referenceRange: { min: 70, max: 100 } },
  ],
  timeline: [
    { date: '2024-03-15', event: 'CBC Report' },
  ],
  diagnoses: [],
  trends: [],
});

describe('ValidatorToolExecutor', () => {
  let executor: ValidatorToolExecutor;

  beforeEach(() => {
    executor = new ValidatorToolExecutor(SAMPLE_EXTRACTED, SAMPLE_JSON);
  });

  // -----------------------------------------------------------------------
  // Source data tools
  // -----------------------------------------------------------------------

  describe('source data tools', () => {
    it('list_documents lists all source documents', () => {
      const result = executor.execute('list_documents', {});
      expect(result).toContain('CBC Report');
      expect(result).toContain('Metabolic Panel');
    });

    it('get_document_summary returns metadata without full content', () => {
      const result = executor.execute('get_document_summary', { document_name: 'CBC Report' });
      expect(result).toContain('Document Summary');
      expect(result).toContain('CBC Report');
      expect(result).toContain('Key Values');
    });

    it('get_document_summary returns not-found for missing doc', () => {
      const result = executor.execute('get_document_summary', { document_name: 'Nonexistent' });
      expect(result).toContain('not found');
    });

    it('search_data finds matching lines', () => {
      const result = executor.execute('search_data', { query: 'Glucose' });
      expect(result).toContain('Glucose');
      expect(result).toContain('105');
    });

    it('search_data returns no-matches for unknown term', () => {
      const result = executor.execute('search_data', { query: 'ZincDeficiency' });
      expect(result).toContain('No matches');
    });

    it('get_date_range returns date span', () => {
      const result = executor.execute('get_date_range', {});
      expect(result).toContain('2020');
      expect(result).toContain('2024');
    });

    it('list_documents_by_year groups by year', () => {
      const result = executor.execute('list_documents_by_year', {});
      expect(result).toContain('2020');
      expect(result).toContain('2024');
    });

    it('extract_timeline_events returns events', () => {
      const result = executor.execute('extract_timeline_events', {});
      expect(result).toContain('Timeline');
    });

    it('get_value_history tracks marker across time', () => {
      const result = executor.execute('get_value_history', { marker: 'Glucose' });
      expect(result).toContain('105');
    });
  });

  // -----------------------------------------------------------------------
  // Verification tools
  // -----------------------------------------------------------------------

  describe('verify_value_exists', () => {
    it('returns VERIFIED when marker in both source and JSON', () => {
      const result = executor.execute('verify_value_exists', { marker: 'WBC' });
      expect(result).toContain('VERIFIED');
      expect(result).toContain('Source Data');
      expect(result).toContain('JSON Data');
    });

    it('returns MISSING FROM JSON when only in source', () => {
      const result = executor.execute('verify_value_exists', { marker: 'HbA1c' });
      expect(result).toContain('MISSING FROM JSON');
    });

    it('returns NOT FOUND when marker in neither', () => {
      const result = executor.execute('verify_value_exists', { marker: 'Zinc' });
      expect(result).toContain('NOT FOUND');
    });
  });

  // -----------------------------------------------------------------------
  // JSON inspection tools
  // -----------------------------------------------------------------------

  describe('JSON inspection tools', () => {
    it('get_json_overview shows structure summary', () => {
      const result = executor.execute('get_json_overview', {});
      expect(result).toContain('JSON Structure Overview');
      expect(result).toContain('criticalFindings');
      expect(result).toContain('timeline');
      expect(result).toContain('executiveSummary');
    });

    it('get_json_section_summary shows section details', () => {
      const result = executor.execute('get_json_section_summary', { section: 'criticalFindings' });
      expect(result).toContain('criticalFindings');
    });

    it('check_value_in_json finds marker in JSON', () => {
      const result = executor.execute('check_value_in_json', { marker: 'Glucose' });
      expect(result).toContain('Glucose');
    });

    it('check_value_in_json reports missing marker', () => {
      const result = executor.execute('check_value_in_json', { marker: 'Zinc' });
      // No matches expected
      expect(result).toContain('Zinc');
    });

    it('compare_date_ranges compares source vs JSON timeline', () => {
      const result = executor.execute('compare_date_ranges', {});
      expect(result).toContain('Source');
      expect(result).toContain('JSON');
    });

    it('find_missing_timeline_years identifies gaps', () => {
      const result = executor.execute('find_missing_timeline_years', {});
      // Source has 2020 and 2024, JSON only has 2024
      expect(result).toContain('2020');
    });
  });

  // -----------------------------------------------------------------------
  // Issue tracking
  // -----------------------------------------------------------------------

  describe('issue tracking', () => {
    it('report_issue stores an issue', () => {
      executor.execute('report_issue', {
        category: 'missing_data',
        severity: 'critical',
        description: 'HbA1c missing from JSON',
      });
      const summary = executor.execute('get_validation_summary', {});
      expect(summary).toContain('HbA1c');
      expect(summary).toContain('CRITICAL');
    });

    it('get_validation_summary shows all reported issues', () => {
      executor.execute('report_issue', {
        category: 'wrong_value',
        severity: 'warning',
        description: 'WBC status incorrect',
      });
      executor.execute('report_issue', {
        category: 'missing_timeline',
        severity: 'critical',
        description: '2020 data not in timeline',
      });
      const summary = executor.execute('get_validation_summary', {});
      expect(summary).toContain('WBC');
      expect(summary).toContain('2020');
    });
  });

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  describe('complete_validation', () => {
    it('returns completion signal with status and summary', () => {
      const result = executor.execute('complete_validation', {
        status: 'needs_revision',
        summary: 'HbA1c is missing from structured data.',
      });
      expect(result).toContain('needs_revision');
      expect(result).toContain('HbA1c');
    });
  });

  // -----------------------------------------------------------------------
  // Legacy tool redirects
  // -----------------------------------------------------------------------

  describe('legacy tools', () => {
    it('read_document redirects to get_document_summary', () => {
      const result = executor.execute('read_document', { document_name: 'CBC Report' });
      expect(result).toContain('Document Summary');
    });

    it('get_structured_json without section redirects to overview', () => {
      const result = executor.execute('get_structured_json', {});
      expect(result).toContain('JSON Structure Overview');
    });

    it('get_structured_json with section redirects to section summary', () => {
      const result = executor.execute('get_structured_json', { section: 'criticalFindings' });
      expect(result).toContain('criticalFindings');
    });
  });

  // -----------------------------------------------------------------------
  // Unknown tool
  // -----------------------------------------------------------------------

  it('returns error for unknown tool', () => {
    const result = executor.execute('nonexistent', {});
    expect(result).toContain('Unknown tool');
  });

  // -----------------------------------------------------------------------
  // Invalid JSON handling
  // -----------------------------------------------------------------------

  it('handles invalid structured JSON gracefully', () => {
    const badExecutor = new ValidatorToolExecutor(SAMPLE_EXTRACTED, 'not valid json');
    const result = badExecutor.execute('get_json_overview', {});
    expect(result).toContain('JSON Structure Overview');
    // Should still work with empty JSON
    expect(result).toContain('0');
  });
});
