/**
 * Tests for utils/json-patch-merge.ts
 *
 * Verifies deepMergeJsonPatch rules:
 * - Objects: recursive merge
 * - Arrays: replace mode (with _action marker) or append mode
 * - Primitives: override
 * - null: explicit clear
 */

import { describe, it, expect } from 'vitest';
import { deepMergeJsonPatch } from '../utils/json-patch-merge.js';

describe('deepMergeJsonPatch', () => {
  // -----------------------------------------------------------------------
  // Primitive overrides
  // -----------------------------------------------------------------------

  it('overrides primitive values', () => {
    const result = deepMergeJsonPatch({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it('overrides string with number', () => {
    const result = deepMergeJsonPatch({ a: 'hello' }, { a: 42 });
    expect(result).toEqual({ a: 42 });
  });

  it('adds new keys from patch', () => {
    const result = deepMergeJsonPatch({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('preserves original keys not in patch', () => {
    const result = deepMergeJsonPatch({ a: 1, b: 2 }, { a: 10 });
    expect(result).toEqual({ a: 10, b: 2 });
  });

  // -----------------------------------------------------------------------
  // null handling
  // -----------------------------------------------------------------------

  it('sets field to null when patch value is null', () => {
    const result = deepMergeJsonPatch({ a: 'value' }, { a: null });
    expect(result).toEqual({ a: null });
  });

  it('sets new field to null', () => {
    const result = deepMergeJsonPatch({ a: 1 }, { b: null });
    expect(result).toEqual({ a: 1, b: null });
  });

  // -----------------------------------------------------------------------
  // Object recursive merge
  // -----------------------------------------------------------------------

  it('recursively merges nested objects', () => {
    const original = { settings: { theme: 'dark', font: 'mono' } };
    const patch = { settings: { theme: 'light' } };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ settings: { theme: 'light', font: 'mono' } });
  });

  it('deeply merges multiple levels', () => {
    const original = { a: { b: { c: 1, d: 2 } } };
    const patch = { a: { b: { c: 99 } } };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ a: { b: { c: 99, d: 2 } } });
  });

  it('replaces object with primitive when patch has primitive', () => {
    const result = deepMergeJsonPatch({ a: { nested: true } }, { a: 'flat' });
    expect(result).toEqual({ a: 'flat' });
  });

  // -----------------------------------------------------------------------
  // Array append mode (default)
  // -----------------------------------------------------------------------

  it('appends patch array to existing array', () => {
    const original = { items: [1, 2] };
    const patch = { items: [3, 4] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [1, 2, 3, 4] });
  });

  it('sets array when original is not an array', () => {
    const original = { items: 'not-array' };
    const patch = { items: [1, 2] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [1, 2] });
  });

  it('sets array when original key does not exist', () => {
    const result = deepMergeJsonPatch({}, { items: [1, 2] });
    expect(result).toEqual({ items: [1, 2] });
  });

  // -----------------------------------------------------------------------
  // Array replace mode (_action: "replace")
  // -----------------------------------------------------------------------

  it('replaces entire array when first element has _action: "replace"', () => {
    const original = { items: ['old1', 'old2'] };
    const patch = { items: [{ _action: 'replace' }, 'new1', 'new2'] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: ['new1', 'new2'] });
  });

  it('replace mode with empty rest results in empty array', () => {
    const original = { items: [1, 2, 3] };
    const patch = { items: [{ _action: 'replace' }] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [] });
  });

  it('does not trigger replace mode if _action is not "replace"', () => {
    const original = { items: [1] };
    const patch = { items: [{ _action: 'append' }, 2] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [1, { _action: 'append' }, 2] });
  });

  it('does not trigger replace mode if first element is null', () => {
    const original = { items: [1] };
    const patch = { items: [null, 2] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [1, null, 2] });
  });

  it('does not trigger replace mode if first element is a primitive', () => {
    const original = { items: [1] };
    const patch = { items: ['hello', 2] };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({ items: [1, 'hello', 2] });
  });

  // -----------------------------------------------------------------------
  // Does not mutate originals
  // -----------------------------------------------------------------------

  it('does not mutate the original object', () => {
    const original = { a: 1, nested: { b: 2 } };
    const originalCopy = JSON.parse(JSON.stringify(original));
    deepMergeJsonPatch(original, { a: 99, nested: { b: 99 } });
    expect(original).toEqual(originalCopy);
  });

  // -----------------------------------------------------------------------
  // Empty inputs
  // -----------------------------------------------------------------------

  it('returns original when patch is empty', () => {
    const result = deepMergeJsonPatch({ a: 1 }, {});
    expect(result).toEqual({ a: 1 });
  });

  it('returns patch when original is empty', () => {
    const result = deepMergeJsonPatch({}, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  // -----------------------------------------------------------------------
  // Complex scenarios
  // -----------------------------------------------------------------------

  it('handles mixed types in a single patch', () => {
    const original = {
      name: 'test',
      scores: [80, 90],
      meta: { version: 1 },
      deprecated: 'yes',
    };
    const patch = {
      name: 'updated',
      scores: [95],
      meta: { version: 2, author: 'bot' },
      deprecated: null,
    };
    const result = deepMergeJsonPatch(original, patch);
    expect(result).toEqual({
      name: 'updated',
      scores: [80, 90, 95],
      meta: { version: 2, author: 'bot' },
      deprecated: null,
    });
  });
});
