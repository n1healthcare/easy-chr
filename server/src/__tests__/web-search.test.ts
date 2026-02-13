/**
 * Tests for services/web-search.service.ts
 *
 * Tests the pure function formatWebSearchAsMarkdown.
 * webSearch and webSearchMultiple require a live Gemini Config and are not unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { formatWebSearchAsMarkdown, type WebSearchResult } from '../services/web-search.service.js';

describe('formatWebSearchAsMarkdown', () => {
  it('returns plain text when no sources', () => {
    const result: WebSearchResult = {
      text: 'Tokyo has a population of 14 million.',
      queries: ['tokyo population'],
      sources: [],
    };
    const md = formatWebSearchAsMarkdown(result);
    expect(md).toBe('Tokyo has a population of 14 million.');
    expect(md).not.toContain('Sources');
  });

  it('appends numbered source list with markdown links', () => {
    const result: WebSearchResult = {
      text: 'Vitamin D is important.',
      queries: ['vitamin d importance'],
      sources: [
        { title: 'NIH Page', uri: 'https://nih.gov/vitd' },
        { title: 'Mayo Clinic', uri: 'https://mayoclinic.org/vitd' },
      ],
    };
    const md = formatWebSearchAsMarkdown(result);
    expect(md).toContain('**Sources:**');
    expect(md).toContain('1. [NIH Page](https://nih.gov/vitd)');
    expect(md).toContain('2. [Mayo Clinic](https://mayoclinic.org/vitd)');
  });

  it('handles single source', () => {
    const result: WebSearchResult = {
      text: 'Answer text.',
      queries: [],
      sources: [{ title: 'Only Source', uri: 'https://example.com' }],
    };
    const md = formatWebSearchAsMarkdown(result);
    expect(md).toContain('1. [Only Source](https://example.com)');
    expect(md).not.toContain('2.');
  });

  it('handles empty text with sources', () => {
    const result: WebSearchResult = {
      text: '',
      queries: [],
      sources: [{ title: 'A', uri: 'https://a.com' }],
    };
    const md = formatWebSearchAsMarkdown(result);
    expect(md).toContain('**Sources:**');
    expect(md).toContain('[A](https://a.com)');
  });
});
