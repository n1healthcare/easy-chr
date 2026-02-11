/**
 * Tests for services/chat-compression.service.ts
 *
 * Tests the pure functions: estimateTokenCount, findSplitPoint,
 * getMedicalCompressionPrompt. Does NOT test the ChatCompressionService
 * class (which requires LLM calls).
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokenCount,
  findSplitPoint,
  getMedicalCompressionPrompt,
  type ConversationEntry,
} from '../services/chat-compression.service.js';

// ============================================================================
// estimateTokenCount
// ============================================================================

describe('estimateTokenCount', () => {
  it('returns 0 for an empty history', () => {
    expect(estimateTokenCount([])).toBe(0);
  });

  it('counts ASCII characters at 0.25 tokens per char', () => {
    // A simple entry with all-ASCII text
    const entry: ConversationEntry = {
      role: 'user',
      parts: [{ text: 'hello' }],
    };
    const serialized = JSON.stringify(entry);
    const expectedTokens = Math.ceil(serialized.length * 0.25);
    expect(estimateTokenCount([entry])).toBe(expectedTokens);
  });

  it('counts non-ASCII characters at 1.3 tokens per char', () => {
    // Entry containing only non-ASCII text
    const entry: ConversationEntry = {
      role: 'user',
      parts: [{ text: '\u4e16\u754c' }], // Chinese characters
    };
    const serialized = JSON.stringify(entry);
    let expected = 0;
    for (const char of serialized) {
      if (char.codePointAt(0)! <= 127) {
        expected += 0.25;
      } else {
        expected += 1.3;
      }
    }
    expect(estimateTokenCount([entry])).toBe(Math.ceil(expected));
  });

  it('handles mixed ASCII and non-ASCII text', () => {
    const entry: ConversationEntry = {
      role: 'user',
      parts: [{ text: 'Lab: TSH \u2192 3.5 mIU/L' }],
    };
    const serialized = JSON.stringify(entry);
    let expected = 0;
    for (const char of serialized) {
      if (char.codePointAt(0)! <= 127) {
        expected += 0.25;
      } else {
        expected += 1.3;
      }
    }
    expect(estimateTokenCount([entry])).toBe(Math.ceil(expected));
  });

  it('accounts for JSON serialization overhead (keys, quotes, braces)', () => {
    const entry: ConversationEntry = { role: 'user', parts: [{ text: 'a' }] };
    // The full serialized form is something like:
    // {"role":"user","parts":[{"text":"a"}]}
    // This is much longer than just "a"
    const tokens = estimateTokenCount([entry]);
    // Should be more than just 1 char worth of tokens
    expect(tokens).toBeGreaterThan(1);
  });

  it('sums token counts across multiple entries', () => {
    const entry1: ConversationEntry = { role: 'user', parts: [{ text: 'first' }] };
    const entry2: ConversationEntry = { role: 'model', parts: [{ text: 'second' }] };
    const combined = estimateTokenCount([entry1, entry2]);
    const individual = estimateTokenCount([entry1]) + estimateTokenCount([entry2]);
    // The combined estimate should equal the sum of individual estimates
    // because estimateTokenCount processes entries independently
    expect(combined).toBe(individual);
  });

  it('handles entries with functionCall parts', () => {
    const entry: ConversationEntry = {
      role: 'model',
      parts: [{ functionCall: { name: 'search_data', args: { query: 'TSH' } } }],
    };
    // Should not throw and should return a positive number
    const tokens = estimateTokenCount([entry]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles entries with functionResponse parts', () => {
    const entry: ConversationEntry = {
      role: 'user',
      parts: [{ functionResponse: { name: 'search_data', response: { result: 'found TSH 3.5' } } }],
    };
    const tokens = estimateTokenCount([entry]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns higher token count for longer text', () => {
    const short: ConversationEntry = { role: 'user', parts: [{ text: 'hi' }] };
    const long: ConversationEntry = { role: 'user', parts: [{ text: 'a'.repeat(1000) }] };
    expect(estimateTokenCount([long])).toBeGreaterThan(estimateTokenCount([short]));
  });

  it('always returns an integer (Math.ceil)', () => {
    const entry: ConversationEntry = { role: 'user', parts: [{ text: 'abc' }] };
    const tokens = estimateTokenCount([entry]);
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

// ============================================================================
// findSplitPoint
// ============================================================================

describe('findSplitPoint', () => {
  it('returns 0 for empty history', () => {
    expect(findSplitPoint([], 0.7)).toBe(0);
  });

  it('returns 0 when no safe split points exist (all model messages)', () => {
    const history: ConversationEntry[] = [
      { role: 'model', parts: [{ text: 'thinking...' }] },
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
    ];
    // Last entry has a functionCall, so we can't compress everything
    expect(findSplitPoint(history, 0.7)).toBe(0);
  });

  it('returns split point at a user message that is NOT a function response', () => {
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'start analysis' }] },           // index 0 - safe
      { role: 'model', parts: [{ text: 'analyzing...' }] },            // index 1
      { role: 'user', parts: [{ text: 'continue' }] },                  // index 2 - safe
      { role: 'model', parts: [{ text: 'more analysis' }] },           // index 3
      { role: 'user', parts: [{ text: 'what next?' }] },                // index 4 - safe
    ];
    // With compressFraction 0.7, target is 70% of total chars
    // Split should be at a safe user message after accumulating ~70% of chars
    const result = findSplitPoint(history, 0.7);
    // Should be at a user message (0, 2, or 4)
    expect([0, 2, 4]).toContain(result);
    // And that entry should be a user message
    if (result < history.length) {
      expect(history[result].role).toBe('user');
    }
  });

  it('does NOT split at a user message with functionResponse', () => {
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'start' }] },                     // index 0 - safe
      { role: 'model', parts: [{ functionCall: { name: 'list', args: {} } }] }, // index 1
      { role: 'user', parts: [{ functionResponse: { name: 'list', response: {} } }] }, // index 2 - NOT safe
      { role: 'model', parts: [{ text: 'ok' }] },                       // index 3
      { role: 'user', parts: [{ text: 'continue' }] },                  // index 4 - safe
    ];
    const result = findSplitPoint(history, 0.5);
    // Should never split at index 2 (function response)
    expect(result).not.toBe(2);
  });

  it('can compress entire history when last entry is model text', () => {
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'x'.repeat(100) }] },
      { role: 'model', parts: [{ text: 'y'.repeat(100) }] },
    ];
    // With fraction 0.99, target is nearly everything
    // Since last entry is model text (no function call), it should return contents.length
    const result = findSplitPoint(history, 0.99);
    expect(result).toBe(history.length);
  });

  it('does NOT compress everything when last entry is a model function call', () => {
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'x'.repeat(100) }] },
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
    ];
    // Last entry has functionCall, so we fall back to lastSafeSplitPoint
    const result = findSplitPoint(history, 0.99);
    // lastSafeSplitPoint would be 0 (the user message)
    expect(result).toBeLessThan(history.length);
  });

  it('returns the first safe split point past the target character count', () => {
    // Create entries where we know the split should happen at a specific point
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'a'.repeat(100) }] },  // index 0 - safe
      { role: 'model', parts: [{ text: 'b'.repeat(100) }] }, // index 1
      { role: 'user', parts: [{ text: 'c'.repeat(100) }] },  // index 2 - safe
      { role: 'model', parts: [{ text: 'd'.repeat(100) }] }, // index 3
      { role: 'user', parts: [{ text: 'e'.repeat(100) }] },  // index 4 - safe
    ];
    // With fraction 0.5, target is ~50% of total chars.
    // The algorithm checks cumulativeChars BEFORE adding the current entry.
    // At index 0 (safe): cumulative=0, not past target. lastSafe=0. cumulative += charCounts[0]
    // At index 2 (safe): cumulative=charCounts[0]+[1]≈40%, not past target. lastSafe=2.
    // At index 4 (safe): cumulative=charCounts[0]+[1]+[2]+[3]≈80%, past target. Returns 4.
    const result = findSplitPoint(history, 0.5);
    expect(result).toBe(4);
  });

  it('falls back to lastSafeSplitPoint when target is passed without a safe point after', () => {
    // All user messages are function responses except the first
    const history: ConversationEntry[] = [
      { role: 'user', parts: [{ text: 'start' }] },                     // index 0 - safe
      { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] },
      { role: 'model', parts: [{ functionCall: { name: 'b', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'b', response: {} } }] },
      { role: 'model', parts: [{ functionCall: { name: 'c', args: {} } }] },
    ];
    // Last entry has functionCall, so we can't return contents.length
    // The only safe split point is index 0
    const result = findSplitPoint(history, 0.7);
    expect(result).toBe(0);
  });
});

// ============================================================================
// getMedicalCompressionPrompt
// ============================================================================

describe('getMedicalCompressionPrompt', () => {
  it('returns analyst prompt for phase "analyst"', () => {
    const prompt = getMedicalCompressionPrompt('analyst');
    expect(prompt).toContain('medical analysis agent');
    expect(prompt).toContain('<state_snapshot>');
    expect(prompt).toContain('<key_findings>');
    expect(prompt).toContain('<documents_explored>');
    expect(prompt).toContain('<analysis_state>');
    expect(prompt).toContain('<current_investigation>');
  });

  it('returns validator prompt for phase "validator"', () => {
    const prompt = getMedicalCompressionPrompt('validator');
    expect(prompt).toContain('medical data validation agent');
    expect(prompt).toContain('<state_snapshot>');
    expect(prompt).toContain('<key_findings>');
    expect(prompt).toContain('<documents_checked>');
    expect(prompt).toContain('<validation_state>');
    expect(prompt).toContain('<current_investigation>');
  });

  it('analyst prompt does NOT contain validator-specific sections', () => {
    const prompt = getMedicalCompressionPrompt('analyst');
    expect(prompt).not.toContain('<documents_checked>');
    expect(prompt).not.toContain('<validation_state>');
  });

  it('validator prompt does NOT contain analyst-specific sections', () => {
    const prompt = getMedicalCompressionPrompt('validator');
    expect(prompt).not.toContain('<documents_explored>');
    expect(prompt).not.toContain('<analysis_state>');
  });

  it('both prompts contain scratchpad instruction', () => {
    const analyst = getMedicalCompressionPrompt('analyst');
    const validator = getMedicalCompressionPrompt('validator');
    expect(analyst).toContain('<scratchpad>');
    expect(validator).toContain('<scratchpad>');
  });

  it('both prompts emphasize density and preservation of information', () => {
    const analyst = getMedicalCompressionPrompt('analyst');
    const validator = getMedicalCompressionPrompt('validator');
    expect(analyst).toContain('EXTREMELY dense');
    expect(validator).toContain('EXTREMELY dense');
  });

  it('analyst prompt includes patient_overview section', () => {
    const prompt = getMedicalCompressionPrompt('analyst');
    expect(prompt).toContain('<patient_overview>');
  });

  it('validator prompt includes patient_overview section', () => {
    const prompt = getMedicalCompressionPrompt('validator');
    expect(prompt).toContain('<patient_overview>');
  });
});
