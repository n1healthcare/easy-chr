/**
 * Tests for utils/source-excerpts.ts
 *
 * Verifies extractLabSections and extractSourceExcerpts:
 * - Lab section detection by pipe density
 * - Section parsing from ## [name] headers
 * - Search term extraction (quoted, medical, numbers with units)
 * - Context window around matches
 * - maxBytes truncation
 */

import { describe, it, expect } from 'vitest';
import { extractLabSections, extractSourceExcerpts } from '../utils/source-excerpts.js';

// ---------------------------------------------------------------------------
// extractLabSections
// ---------------------------------------------------------------------------

describe('extractLabSections', () => {
  it('extracts sections with pipe-delimited lab data', () => {
    const content = [
      '## [CBC Report]',
      '| Marker | Value | Ref Range | Unit |',
      '| WBC | 5.2 | 4.0-10.0 | K/uL |',
      '| RBC | 4.8 | 4.5-5.5 | M/uL |',
      '## [Notes]',
      'Patient felt fine.',
    ].join('\n');

    const result = extractLabSections(content);
    expect(result).toContain('CBC Report');
    expect(result).toContain('WBC');
    expect(result).not.toContain('Patient felt fine');
  });

  it('returns no-data message when no lab tables exist', () => {
    const content = [
      '## [Summary]',
      'Patient is doing well.',
      'No lab work performed.',
    ].join('\n');

    const result = extractLabSections(content);
    expect(result).toBe('(No lab data tables found in source documents)');
  });

  it('sorts sections by lab density (most dense first)', () => {
    const content = [
      '## [Small Panel]',
      '| A | 1 | 0-5 | U/L |',
      'Some text here.',
      '## [Big Panel]',
      '| A | 1 | 0-5 | U/L |',
      '| B | 2 | 0-5 | U/L |',
      '| C | 3 | 0-5 | U/L |',
      '| D | 4 | 0-5 | U/L |',
    ].join('\n');

    const result = extractLabSections(content);
    // Big Panel should appear before Small Panel
    const bigIdx = result.indexOf('Big Panel');
    const smallIdx = result.indexOf('Small Panel');
    expect(bigIdx).toBeLessThan(smallIdx);
  });

  it('respects maxBytes limit and truncates', () => {
    // Build a large section
    const lines = ['## [Huge Panel]'];
    for (let i = 0; i < 500; i++) {
      lines.push(`| Marker${i} | ${i} | 0-100 | mg/dL |`);
    }
    const content = lines.join('\n');

    const result = extractLabSections(content, 500);
    expect(result).toContain('TRUNCATED');
  });

  it('handles last section correctly (no trailing header)', () => {
    const content = [
      '## [Only Panel]',
      '| TSH | 2.5 | 0.4-4.0 | mIU/L |',
      '| FT4 | 1.2 | 0.8-1.8 | ng/dL |',
    ].join('\n');

    const result = extractLabSections(content);
    expect(result).toContain('TSH');
    expect(result).toContain('FT4');
  });
});

// ---------------------------------------------------------------------------
// extractSourceExcerpts
// ---------------------------------------------------------------------------

describe('extractSourceExcerpts', () => {
  const sampleContent = [
    '## [CBC Report]',
    'Date: 2024-03-15',
    'Lab Results:',
    'Homocysteine: 20.08 umol/L (ref 5-15) *H',
    'Vitamin B6: 3.2 ng/mL (ref 5-50) *L',
    'Normal text line 1',
    'Normal text line 2',
    '## [Metabolic Panel]',
    'Glucose: 105 mg/dL',
    'HbA1c: 5.7%',
  ].join('\n');

  it('finds excerpts matching quoted strings in issue descriptions', () => {
    const issues = [{ description: 'The value "Homocysteine" is missing from JSON' }];
    const result = extractSourceExcerpts(sampleContent, issues);
    expect(result).toContain('Homocysteine');
    expect(result).toContain('20.08');
  });

  it('finds excerpts matching numbers with units', () => {
    const issues = [{ description: 'Source shows 20.08 umol/L but JSON has wrong value' }];
    const result = extractSourceExcerpts(sampleContent, issues);
    expect(result).toContain('20.08');
  });

  it('finds excerpts matching multi-word medical terms', () => {
    const issues = [{ description: 'Vitamin B6 is not captured' }];
    const result = extractSourceExcerpts(sampleContent, issues);
    expect(result).toContain('Vitamin B6');
  });

  it('returns no-match message when nothing found', () => {
    const issues = [{ description: 'The "Zinc" level is incorrect' }];
    const result = extractSourceExcerpts(sampleContent, issues);
    expect(result).toContain('No matches found');
  });

  it('returns no-terms message when issues have only stop words', () => {
    const issues = [{ description: 'the and but for' }];
    const result = extractSourceExcerpts(sampleContent, issues);
    expect(result).toContain('No search terms');
  });

  it('includes context lines around matches', () => {
    const issues = [{ description: 'Check "Glucose"' }];
    const result = extractSourceExcerpts(sampleContent, issues, { contextLines: 2 });
    expect(result).toContain('Glucose');
    // Should also include nearby lines
    expect(result).toContain('HbA1c');
  });

  it('respects maxBytes truncation', () => {
    const issues = [{ description: '"Homocysteine" "Glucose"' }];
    const result = extractSourceExcerpts(sampleContent, issues, { maxBytes: 50 });
    expect(result).toContain('TRUNCATED');
  });

  it('groups contiguous matched lines into ranges', () => {
    const issues = [{ description: 'Check "Homocysteine"' }];
    const result = extractSourceExcerpts(sampleContent, issues, { contextLines: 1 });
    // Should show line range markers
    expect(result).toMatch(/lines \d+-\d+/);
  });
});
