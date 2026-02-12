/**
 * Tests for question-driven analysis mode.
 *
 * Tests the isDefaultPrompt classifier that determines whether the pipeline
 * runs in focused (question-driven) or comprehensive mode.
 */

import { describe, it, expect } from 'vitest';
import { isDefaultPrompt } from '../services/agentic-medical-analyst.service.js';

describe('isDefaultPrompt', () => {
  it('returns true for empty/blank prompts', () => {
    expect(isDefaultPrompt('')).toBe(true);
    expect(isDefaultPrompt('  ')).toBe(true);
    expect(isDefaultPrompt(null as unknown as string)).toBe(true);
    expect(isDefaultPrompt(undefined as unknown as string)).toBe(true);
  });

  it('returns true for known default prompts', () => {
    expect(isDefaultPrompt('Visualize this document.')).toBe(true);
    expect(isDefaultPrompt('Analyze my health')).toBe(true);
    expect(isDefaultPrompt('generate a report')).toBe(true);
    expect(isDefaultPrompt('Analyze this!')).toBe(true);
    expect(isDefaultPrompt('Create a health report')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isDefaultPrompt('  VISUALIZE THIS DOCUMENT  ')).toBe(true);
    expect(isDefaultPrompt('ANALYZE MY HEALTH.')).toBe(true);
  });

  it('returns false for specific patient questions', () => {
    expect(isDefaultPrompt('What do my vitamin levels look like?')).toBe(false);
    expect(isDefaultPrompt('Is my thyroid normal?')).toBe(false);
    expect(isDefaultPrompt('Should I be worried about my cholesterol?')).toBe(false);
    expect(isDefaultPrompt('Explain my inflammation markers')).toBe(false);
    expect(isDefaultPrompt('Why am I always tired?')).toBe(false);
  });

  it('returns false for prompts with additional context', () => {
    expect(isDefaultPrompt('Analyze my health focusing on cardiac markers')).toBe(false);
    expect(isDefaultPrompt('Visualize this document with focus on vitamins')).toBe(false);
  });

  it('strips conversational filler and still matches defaults', () => {
    expect(isDefaultPrompt('Please analyze my health')).toBe(true);
    expect(isDefaultPrompt('Can you generate a report?')).toBe(true);
    expect(isDefaultPrompt('Could you visualize this document')).toBe(true);
    expect(isDefaultPrompt('analyze this please')).toBe(true);
  });

  it('does not strip filler from specific questions', () => {
    expect(isDefaultPrompt('Please explain my vitamin D levels')).toBe(false);
    expect(isDefaultPrompt('Can you check my thyroid results?')).toBe(false);
  });
});
