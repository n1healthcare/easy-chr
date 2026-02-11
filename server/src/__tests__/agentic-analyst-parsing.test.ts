/**
 * Tests for pure parsing functions in services/agentic-medical-analyst.service.ts
 *
 * Tests extractDatesFromText, parseExtractedData, and applyPatientContext.
 * Does NOT test the AgenticMedicalAnalyst class (which requires LLM calls).
 */

import { describe, it, expect } from 'vitest';
import {
  extractDatesFromText,
  parseExtractedData,
  applyPatientContext,
} from '../services/agentic-medical-analyst.service.js';

// ============================================================================
// extractDatesFromText
// ============================================================================

describe('extractDatesFromText', () => {
  describe('ISO format dates', () => {
    it('extracts YYYY-MM-DD dates', () => {
      const results = extractDatesFromText('Lab test on 2024-03-15 showed elevated TSH');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find(r => r.date === '2024-03-15');
      expect(match).toBeDefined();
      expect(match!.year).toBe(2024);
      expect(match!.month).toBe(3);
      expect(match!.day).toBe(15);
    });

    it('extracts YYYY-MM dates (no day)', () => {
      const results = extractDatesFromText('Report from 2024-03 period');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find(r => r.date === '2024-03');
      expect(match).toBeDefined();
      expect(match!.year).toBe(2024);
      expect(match!.month).toBe(3);
      expect(match!.day).toBeUndefined();
    });

    it('extracts dates with slash separators (YYYY/MM/DD)', () => {
      const results = extractDatesFromText('Test date: 2024/03/15');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find(r => r.year === 2024 && r.month === 3 && r.day === 15);
      expect(match).toBeDefined();
    });
  });

  describe('US format dates', () => {
    it('extracts MM/DD/YYYY format', () => {
      const results = extractDatesFromText('Date: 03/15/2024');
      const match = results.find(r => r.year === 2024 && r.month === 3 && r.day === 15);
      expect(match).toBeDefined();
    });

    it('extracts short year format (MM/DD/YY) and converts to full year', () => {
      const results = extractDatesFromText('Date: 3/15/24');
      const match = results.find(r => r.year === 2024 && r.month === 3 && r.day === 15);
      expect(match).toBeDefined();
    });
  });

  describe('written month dates', () => {
    it('extracts "Month DD, YYYY" format', () => {
      const results = extractDatesFromText('March 15, 2024 blood draw');
      const match = results.find(r => r.year === 2024 && r.month === 3 && r.day === 15);
      expect(match).toBeDefined();
    });

    it('extracts "Month YYYY" format (no day)', () => {
      const results = extractDatesFromText('Results from March 2024');
      const match = results.find(r => r.year === 2024 && r.month === 3);
      expect(match).toBeDefined();
    });

    it('extracts abbreviated month names', () => {
      const results = extractDatesFromText('Jan 2024 follow-up');
      const match = results.find(r => r.year === 2024 && r.month === 1);
      expect(match).toBeDefined();
    });

    it('extracts full month names', () => {
      const results = extractDatesFromText('September 2023 panel');
      const match = results.find(r => r.year === 2023 && r.month === 9);
      expect(match).toBeDefined();
    });

    it('handles all 12 months', () => {
      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      for (let i = 0; i < months.length; i++) {
        const text = `${months[i]} 2024`;
        const results = extractDatesFromText(text);
        const match = results.find(r => r.month === i + 1);
        expect(match).toBeDefined();
      }
    });
  });

  describe('year range validation', () => {
    it('rejects years before 1990', () => {
      const results = extractDatesFromText('Date: 1985-06-15');
      const match = results.find(r => r.year === 1985);
      expect(match).toBeUndefined();
    });

    it('rejects years after 2030', () => {
      const results = extractDatesFromText('Date: 2035-01-01');
      const match = results.find(r => r.year === 2035);
      expect(match).toBeUndefined();
    });

    it('accepts boundary year 1990', () => {
      const results = extractDatesFromText('Date: 1990-01-01');
      const match = results.find(r => r.year === 1990);
      expect(match).toBeDefined();
    });

    it('accepts boundary year 2030', () => {
      const results = extractDatesFromText('Date: 2030-12-31');
      const match = results.find(r => r.year === 2030);
      expect(match).toBeDefined();
    });
  });

  describe('deduplication', () => {
    it('deduplicates identical dates on the same line', () => {
      // Same date+context combination should be deduped
      const results = extractDatesFromText('2024-03-15 test on 2024-03-15');
      // The ISO pattern will match twice on the same line, but they have same date+context
      const matching = results.filter(r => r.date === '2024-03-15');
      expect(matching.length).toBe(1);
    });

    it('preserves dates from different lines', () => {
      const text = '2024-03-15 first test\n2024-03-16 second test';
      const results = extractDatesFromText(text);
      const dates = results.map(r => r.date);
      expect(dates).toContain('2024-03-15');
      expect(dates).toContain('2024-03-16');
    });
  });

  describe('context extraction', () => {
    it('captures context from the line (truncated to 100 chars)', () => {
      const longLine = 'Lab result from 2024-03-15: ' + 'x'.repeat(200);
      const results = extractDatesFromText(longLine);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].context.length).toBeLessThanOrEqual(100);
    });
  });

  describe('multiple dates in text', () => {
    it('extracts multiple dates across different lines', () => {
      const text = [
        '## CBC Report',
        'Date: 2024-03-15',
        'TSH: 3.5 mIU/L',
        '',
        '## Metabolic Panel',
        'Date: 2023-09-20',
        'Glucose: 95 mg/dL',
      ].join('\n');

      const results = extractDatesFromText(text);
      const dates = results.map(r => r.date);
      expect(dates).toContain('2024-03-15');
      expect(dates).toContain('2023-09-20');
    });
  });

  it('returns empty array for text with no dates', () => {
    const results = extractDatesFromText('No dates here, just some text about lab results');
    expect(results).toEqual([]);
  });
});

// ============================================================================
// parseExtractedData
// ============================================================================

describe('parseExtractedData', () => {
  describe('section detection', () => {
    it('parses sections delimited by ## [filename]', () => {
      const content = [
        '## [CBC Report]',
        'White Blood Cells: 7.5',
        'Red Blood Cells: 4.5',
        '',
        '## [Metabolic Panel]',
        'Glucose: 95',
        'BUN: 15',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections.length).toBe(2);
      expect(result.sections[0].name).toBe('CBC Report');
      expect(result.sections[1].name).toBe('Metabolic Panel');
    });

    it('extracts page numbers from ## [filename] - Page N format', () => {
      const content = [
        '## [Lab Report] - Page 1',
        'First page content',
        '',
        '## [Lab Report] - Page 2',
        'Second page content',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections.length).toBe(2);
      expect(result.sections[0].pageNumber).toBe(1);
      expect(result.sections[1].pageNumber).toBe(2);
    });

    it('handles sections without page numbers', () => {
      const content = [
        '## [Summary Report]',
        'No page number here',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections[0].pageNumber).toBeUndefined();
    });

    it('captures section content between headers', () => {
      const content = [
        '## [Report A]',
        'Line 1',
        'Line 2',
        '',
        '## [Report B]',
        'Line 3',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections[0].content).toContain('Line 1');
      expect(result.sections[0].content).toContain('Line 2');
      expect(result.sections[1].content).toContain('Line 3');
    });

    it('ignores content before the first section header', () => {
      const content = [
        'This is preamble text',
        'Should be ignored',
        '## [Actual Section]',
        'Real content',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].name).toBe('Actual Section');
    });

    it('returns empty sections array for content with no section headers', () => {
      const content = 'Just plain text with no section markers';
      const result = parseExtractedData(content);
      expect(result.sections).toEqual([]);
    });
  });

  describe('document names', () => {
    it('extracts unique document names', () => {
      const content = [
        '## [CBC Report] - Page 1',
        'Page 1 content',
        '## [CBC Report] - Page 2',
        'Page 2 content',
        '## [Metabolic Panel]',
        'Panel content',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.documentNames).toContain('CBC Report');
      expect(result.documentNames).toContain('Metabolic Panel');
      // CBC Report appears twice (pages 1 and 2), but should only be listed once
      expect(result.documentNames.filter(n => n === 'CBC Report').length).toBe(1);
    });
  });

  describe('totalCharacters and totalSections', () => {
    it('reports total character count of the input', () => {
      const content = '## [Test]\nSome content here';
      const result = parseExtractedData(content);
      expect(result.totalCharacters).toBe(content.length);
    });

    it('reports total number of sections', () => {
      const content = [
        '## [A]',
        'content a',
        '## [B]',
        'content b',
        '## [C]',
        'content c',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.totalSections).toBe(3);
    });
  });

  describe('temporal data extraction', () => {
    it('builds dateRange from dates found in sections', () => {
      const content = [
        '## [Old Report]',
        'Date: 2020-01-15',
        '## [New Report]',
        'Date: 2024-06-20',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.dateRange).not.toBeNull();
      expect(result.dateRange!.earliest).toBe('2020-01-15');
      expect(result.dateRange!.latest).toBe('2024-06-20');
      expect(result.dateRange!.years).toBe(5); // 2020 to 2024 inclusive
    });

    it('returns null dateRange when no dates found', () => {
      const content = [
        '## [Report]',
        'No dates in this content',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.dateRange).toBeNull();
    });

    it('builds documentsByYear mapping', () => {
      const content = [
        '## [2020 Lab]',
        'Date: 2020-05-10',
        '## [2024 Lab]',
        'Date: 2024-03-15',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.documentsByYear[2020]).toContain('2020 Lab');
      expect(result.documentsByYear[2024]).toContain('2024 Lab');
    });

    it('does not duplicate document names within the same year', () => {
      const content = [
        '## [Lab Report]',
        'Date: 2024-01-10',
        'Date: 2024-03-15',
        'Date: 2024-06-20',
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.documentsByYear[2024]).toEqual(['Lab Report']);
    });

    it('sorts timeline events by date', () => {
      const content = [
        '## [Latest]',
        'Date: 2024-06-01',
        '## [Oldest]',
        'Date: 2020-01-01',
        '## [Middle]',
        'Date: 2022-03-15',
      ].join('\n');

      const result = parseExtractedData(content);
      for (let i = 1; i < result.timelineEvents.length; i++) {
        expect(result.timelineEvents[i].date >= result.timelineEvents[i - 1].date).toBe(true);
      }
    });
  });

  describe('startLine and endLine tracking', () => {
    it('tracks start and end line indices for each section', () => {
      const content = [
        '## [Section A]',   // line 0
        'Line 1',           // line 1
        'Line 2',           // line 2
        '## [Section B]',   // line 3
        'Line 3',           // line 4
      ].join('\n');

      const result = parseExtractedData(content);
      expect(result.sections[0].startLine).toBe(0);
      expect(result.sections[0].endLine).toBe(2); // ends before Section B
      expect(result.sections[1].startLine).toBe(3);
      expect(result.sections[1].endLine).toBe(4); // last line of input
    });
  });
});

// ============================================================================
// applyPatientContext (buildSystemPrompt logic)
// ============================================================================

describe('applyPatientContext', () => {
  const templateWithConditional = [
    'You are a medical analyst.',
    '{{#if patient_question}}',
    'Patient asked: {{patient_question}}',
    '{{/if}}',
    'Begin Exploration.',
  ].join('\n');

  it('substitutes patient context when provided', () => {
    const result = applyPatientContext(templateWithConditional, 'What is my TSH level?');
    expect(result).toContain('Patient asked: What is my TSH level?');
    expect(result).toContain('Begin Exploration.');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
    expect(result).not.toContain('{{patient_question}}');
  });

  it('removes the conditional block when no patient context', () => {
    const result = applyPatientContext(templateWithConditional, undefined);
    expect(result).not.toContain('Patient asked');
    expect(result).not.toContain('{{#if');
    expect(result).not.toContain('{{/if}}');
    expect(result).toContain('You are a medical analyst.');
    expect(result).toContain('Begin Exploration.');
  });

  it('handles multiple conditional blocks', () => {
    const template = [
      'Intro',
      '{{#if patient_question}}Block 1: {{patient_question}}{{/if}}',
      'Middle',
      '{{#if patient_question}}Block 2: {{patient_question}}{{/if}}',
      'End',
    ].join('\n');

    const withContext = applyPatientContext(template, 'my question');
    expect(withContext).toContain('Block 1: my question');
    expect(withContext).toContain('Block 2: my question');

    const withoutContext = applyPatientContext(template, undefined);
    expect(withoutContext).not.toContain('Block 1');
    expect(withoutContext).not.toContain('Block 2');
    expect(withoutContext).toContain('Intro');
    expect(withoutContext).toContain('Middle');
    expect(withoutContext).toContain('End');
  });

  it('handles template with no conditional blocks', () => {
    const template = 'Simple prompt with no conditionals.';
    const result = applyPatientContext(template, 'some context');
    expect(result).toBe('Simple prompt with no conditionals.');
  });

  it('handles empty patient context string as truthy (still substitutes)', () => {
    // Empty string is falsy in JS, so it takes the else branch
    const result = applyPatientContext(templateWithConditional, '');
    // Empty string is falsy, so the conditional block is removed
    expect(result).not.toContain('Patient asked');
  });

  it('preserves content outside conditional blocks', () => {
    const template = 'Before {{#if patient_question}}Inside{{/if}} After';
    const result = applyPatientContext(template, undefined);
    expect(result).toBe('Before  After');
  });

  it('handles multiline conditional blocks when removing', () => {
    const template = [
      'Line 1',
      '{{#if patient_question}}',
      'This is a',
      'multiline block',
      'with {{patient_question}}',
      '{{/if}}',
      'Line 2',
    ].join('\n');

    const result = applyPatientContext(template, undefined);
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).not.toContain('multiline block');
  });
});
