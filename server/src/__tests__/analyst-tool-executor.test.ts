/**
 * Tests for AnalystToolExecutor from agentic-medical-analyst.service.ts
 *
 * Tests tool dispatch, state management, coverage tracking, and completion enforcement.
 * Does NOT test the LLM-calling AgenticMedicalAnalyst class.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AnalystToolExecutor } from '../services/agentic-medical-analyst.service.js';

// Sample extracted content mimicking real pipeline output
const SAMPLE_EXTRACTED = `## [CBC Report]
Date: 2024-03-15
Complete Blood Count Results:
| WBC | 5.2 | 4.0-10.0 | K/uL |
| RBC | 4.8 | 4.5-5.5 | M/uL |
| Hemoglobin | 14.2 | 12.0-16.0 | g/dL |

## [Metabolic Panel]
Date: 2020-06-10
| Glucose | 105 | 70-100 | mg/dL |
| HbA1c | 5.7 | 4.0-5.6 | % |

## [Thyroid Panel]
Date: 2022-09-01
| TSH | 2.5 | 0.4-4.0 | mIU/L |
`;

describe('AnalystToolExecutor', () => {
  let executor: AnalystToolExecutor;

  beforeEach(() => {
    executor = new AnalystToolExecutor(SAMPLE_EXTRACTED);
  });

  // -----------------------------------------------------------------------
  // Tool dispatch
  // -----------------------------------------------------------------------

  describe('tool dispatch', () => {
    it('list_documents returns document names', () => {
      const result = executor.execute('list_documents', {});
      expect(result).toContain('CBC Report');
      expect(result).toContain('Metabolic Panel');
      expect(result).toContain('Thyroid Panel');
      expect(result).toContain('3 documents');
    });

    it('read_document returns section content', () => {
      const result = executor.execute('read_document', { document_name: 'CBC Report' });
      expect(result).toContain('WBC');
      expect(result).toContain('Hemoglobin');
    });

    it('read_document returns not-found for missing document', () => {
      const result = executor.execute('read_document', { document_name: 'Nonexistent' });
      expect(result).toContain('not found');
    });

    it('search_data finds matching terms across sections', () => {
      const result = executor.execute('search_data', { query: 'Glucose', include_context: true });
      expect(result).toContain('Glucose');
      expect(result).toContain('Metabolic Panel');
    });

    it('search_data returns no matches message', () => {
      const result = executor.execute('search_data', { query: 'ZincDeficiency', include_context: false });
      expect(result).toContain('No matches found');
    });

    it('get_analysis returns empty message initially', () => {
      const result = executor.execute('get_analysis', {});
      expect(result).toContain('empty');
    });

    it('update_analysis creates and retrieves sections', () => {
      executor.execute('update_analysis', {
        section: 'Executive Summary',
        content: 'Patient shows borderline glucose.',
      });
      const result = executor.execute('get_analysis', {});
      expect(result).toContain('Executive Summary');
      expect(result).toContain('borderline glucose');
    });

    it('update_analysis appends to existing section', () => {
      executor.execute('update_analysis', {
        section: 'Findings',
        content: 'Line 1.',
      });
      executor.execute('update_analysis', {
        section: 'Findings',
        content: 'Line 2.',
        replace: false,
      });
      const result = executor.execute('get_analysis', {});
      expect(result).toContain('Line 1.');
      expect(result).toContain('Line 2.');
    });

    it('update_analysis replaces section when replace=true', () => {
      executor.execute('update_analysis', {
        section: 'Findings',
        content: 'Old content.',
      });
      executor.execute('update_analysis', {
        section: 'Findings',
        content: 'New content.',
        replace: true,
      });
      const result = executor.execute('get_analysis', {});
      expect(result).not.toContain('Old content.');
      expect(result).toContain('New content.');
    });

    it('update_analysis with "append" section creates auto-named section', () => {
      const result = executor.execute('update_analysis', {
        section: 'append',
        content: 'Appended section.',
      });
      expect(result).toContain('Section 1');
    });

    it('unknown tool returns error message', () => {
      const result = executor.execute('nonexistent_tool', {});
      expect(result).toContain('Unknown tool');
    });
  });

  // -----------------------------------------------------------------------
  // Temporal awareness tools
  // -----------------------------------------------------------------------

  describe('temporal tools', () => {
    it('get_date_range returns date span and years', () => {
      const result = executor.execute('get_date_range', {});
      expect(result).toContain('2020');
      expect(result).toContain('2024');
      expect(result).toContain('years');
    });

    it('list_documents_by_year groups documents by year', () => {
      const result = executor.execute('list_documents_by_year', {});
      expect(result).toContain('2020');
      expect(result).toContain('2024');
      expect(result).toContain('Metabolic Panel');
    });

    it('extract_timeline_events returns all events', () => {
      const result = executor.execute('extract_timeline_events', {});
      expect(result).toContain('Timeline');
      expect(result).toContain('2020');
      expect(result).toContain('2024');
    });

    it('extract_timeline_events filters by year', () => {
      const result = executor.execute('extract_timeline_events', { year: 2024 });
      expect(result).toContain('2024');
      expect(result).not.toContain('## 2020');
    });

    it('get_value_history finds marker across documents', () => {
      const result = executor.execute('get_value_history', { marker: 'Glucose' });
      expect(result).toContain('105');
      expect(result).toContain('Metabolic Panel');
    });

    it('get_value_history returns not-found for unknown marker', () => {
      const result = executor.execute('get_value_history', { marker: 'Zinc' });
      expect(result).toContain('No values found');
    });
  });

  // -----------------------------------------------------------------------
  // Coverage tracking
  // -----------------------------------------------------------------------

  describe('coverage tracking', () => {
    it('tracks documents read', () => {
      let stats = executor.getCoverageStats();
      expect(stats.documentsRead).toBe(0);

      executor.execute('read_document', { document_name: 'CBC Report' });
      stats = executor.getCoverageStats();
      expect(stats.documentsRead).toBe(1);
    });

    it('tracks searches performed', () => {
      let stats = executor.getCoverageStats();
      expect(stats.searchesPerformed).toBe(0);

      executor.execute('search_data', { query: 'glucose', include_context: false });
      stats = executor.getCoverageStats();
      expect(stats.searchesPerformed).toBe(1);
    });

    it('tracks dateRangeChecked', () => {
      let stats = executor.getCoverageStats();
      expect(stats.dateRangeChecked).toBe(false);

      executor.execute('get_date_range', {});
      stats = executor.getCoverageStats();
      expect(stats.dateRangeChecked).toBe(true);
    });

    it('tracks timelineExtracted', () => {
      let stats = executor.getCoverageStats();
      expect(stats.timelineExtracted).toBe(false);

      executor.execute('extract_timeline_events', {});
      stats = executor.getCoverageStats();
      expect(stats.timelineExtracted).toBe(true);
    });

    it('reports document coverage percentage', () => {
      executor.execute('read_document', { document_name: 'CBC Report' });
      executor.execute('read_document', { document_name: 'Metabolic Panel' });
      const stats = executor.getCoverageStats();
      // 2 of 3 documents = ~67%
      expect(stats.documentCoverage).toBeGreaterThanOrEqual(66);
      expect(stats.documentCoverage).toBeLessThanOrEqual(67);
    });
  });

  // -----------------------------------------------------------------------
  // Completion enforcement
  // -----------------------------------------------------------------------

  describe('complete_analysis enforcement', () => {
    it('rejects completion when requirements are not met', () => {
      const result = executor.execute('complete_analysis', {
        summary: 'Done',
        confidence: 'high',
      });
      expect(result).toContain('Cannot Complete Analysis');
      expect(result).not.toContain('ANALYSIS_COMPLETE');
    });

    it('lists missing required sections', () => {
      const result = executor.execute('complete_analysis', {
        summary: 'Done',
        confidence: 'high',
      });
      expect(result).toContain('Executive Summary');
      expect(result).toContain('Recommendations');
    });

    it('accepts completion when all requirements are met', () => {
      // Read enough documents
      executor.execute('read_document', { document_name: 'CBC Report' });
      executor.execute('read_document', { document_name: 'Metabolic Panel' });

      // Perform enough searches
      executor.execute('search_data', { query: 'glucose', include_context: false });
      executor.execute('search_data', { query: 'hemoglobin', include_context: false });
      executor.execute('search_data', { query: 'TSH', include_context: false });

      // Check date range and timeline
      executor.execute('get_date_range', {});
      executor.execute('extract_timeline_events', {});

      // Write all required sections
      const requiredSections = [
        'Executive Summary',
        'System-by-System Analysis',
        'Medical History Timeline',
        'Unified Root Cause Hypothesis',
        'Causal Chain',
        'Keystone Findings',
        'Recommendations',
        'Missing Data',
      ];
      for (const section of requiredSections) {
        executor.execute('update_analysis', { section, content: `Content for ${section}` });
      }

      // Write enough expected sections (3 minimum)
      const expectedSections = [
        'Competing Hypotheses',
        'Identified Diagnoses',
        'Supplement Schedule',
      ];
      for (const section of expectedSections) {
        executor.execute('update_analysis', { section, content: `Content for ${section}` });
      }

      const result = executor.execute('complete_analysis', {
        summary: 'Comprehensive analysis complete',
        confidence: 'high',
      });
      expect(result).toContain('ANALYSIS_COMPLETE');
      expect(result).toContain('high');
    });
  });
});
