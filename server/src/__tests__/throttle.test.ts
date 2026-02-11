/**
 * Tests for common/throttle.ts
 *
 * Tests processInBatches and processSequentially — pure async logic,
 * no external dependencies.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  processInBatches,
  processSequentially,
  sleep,
  type ThrottleConfig,
} from '../common/throttle.js';

// ============================================================================
// sleep
// ============================================================================

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow some tolerance for timer imprecision
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ============================================================================
// processInBatches
// ============================================================================

describe('processInBatches', () => {
  const fastConfig: ThrottleConfig = {
    maxConcurrent: 2,
    delayBetweenBatchesMs: 0,
    delayBetweenRequestsMs: 0,
  };

  it('processes all items and returns results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await processInBatches(
      items,
      async (item) => item * 10,
      fastConfig,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('returns empty array for empty input', async () => {
    const results = await processInBatches(
      [],
      async (item: number) => item,
      fastConfig,
    );
    expect(results).toEqual([]);
  });

  it('passes correct index to the processor', async () => {
    const items = ['a', 'b', 'c'];
    const indices: number[] = [];
    await processInBatches(
      items,
      async (_item, index) => {
        indices.push(index);
        return index;
      },
      fastConfig,
    );
    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  it('respects maxConcurrent batch size', async () => {
    let maxConcurrentObserved = 0;
    let currentlyRunning = 0;

    const items = [1, 2, 3, 4, 5, 6];
    const config: ThrottleConfig = {
      maxConcurrent: 2,
      delayBetweenBatchesMs: 0,
      delayBetweenRequestsMs: 0,
    };

    await processInBatches(
      items,
      async (item) => {
        currentlyRunning++;
        if (currentlyRunning > maxConcurrentObserved) {
          maxConcurrentObserved = currentlyRunning;
        }
        await sleep(20); // Hold for a bit so concurrency can be observed
        currentlyRunning--;
        return item;
      },
      config,
    );

    // Should never exceed maxConcurrent
    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
  });

  it('handles single item', async () => {
    const results = await processInBatches(
      [42],
      async (item) => item + 1,
      fastConfig,
    );
    expect(results).toEqual([43]);
  });

  it('handles batch size larger than item count', async () => {
    const config: ThrottleConfig = {
      maxConcurrent: 100,
      delayBetweenBatchesMs: 0,
      delayBetweenRequestsMs: 0,
    };
    const results = await processInBatches(
      [1, 2, 3],
      async (item) => item * 2,
      config,
    );
    expect(results).toEqual([2, 4, 6]);
  });

  it('applies delay between batches (not after last batch)', async () => {
    const config: ThrottleConfig = {
      maxConcurrent: 2,
      delayBetweenBatchesMs: 50,
      delayBetweenRequestsMs: 0,
    };

    const batchTimestamps: number[] = [];
    const items = [1, 2, 3, 4]; // 2 batches of 2

    await processInBatches(
      items,
      async (item, index) => {
        batchTimestamps.push(Date.now());
        return item;
      },
      config,
    );

    // Batch 2 items (indices 2,3) should start at least ~50ms after batch 1
    const batch1End = Math.max(batchTimestamps[0], batchTimestamps[1]);
    const batch2Start = Math.min(batchTimestamps[2], batchTimestamps[3]);
    expect(batch2Start - batch1End).toBeGreaterThanOrEqual(30); // some tolerance
  });

  it('propagates errors from the processor', async () => {
    await expect(
      processInBatches(
        [1, 2, 3],
        async (item) => {
          if (item === 2) throw new Error('processor failed');
          return item;
        },
        fastConfig,
      ),
    ).rejects.toThrow('processor failed');
  });

  it('preserves result order across multiple batches', async () => {
    const config: ThrottleConfig = {
      maxConcurrent: 3,
      delayBetweenBatchesMs: 50,
      delayBetweenRequestsMs: 0,
    };

    // 7 items with maxConcurrent 3 = batches of [3, 3, 1]
    const results = await processInBatches(
      [10, 20, 30, 40, 50, 60, 70],
      async (item) => item + 1,
      config,
    );
    expect(results).toEqual([11, 21, 31, 41, 51, 61, 71]);
  });
});

// ============================================================================
// processSequentially
// ============================================================================

describe('processSequentially', () => {
  it('processes all items and returns results in order', async () => {
    const items = [1, 2, 3];
    const results = await processSequentially(
      items,
      async (item) => item * 10,
      0,
    );
    expect(results).toEqual([10, 20, 30]);
  });

  it('returns empty array for empty input', async () => {
    const results = await processSequentially(
      [],
      async (item: number) => item,
      0,
    );
    expect(results).toEqual([]);
  });

  it('passes correct index to the processor', async () => {
    const items = ['a', 'b', 'c'];
    const indices: number[] = [];
    await processSequentially(
      items,
      async (_item, index) => {
        indices.push(index);
        return index;
      },
      0,
    );
    expect(indices).toEqual([0, 1, 2]); // Always in order for sequential
  });

  it('executes items strictly one at a time', async () => {
    let maxConcurrent = 0;
    let currentlyRunning = 0;

    await processSequentially(
      [1, 2, 3],
      async (item) => {
        currentlyRunning++;
        if (currentlyRunning > maxConcurrent) {
          maxConcurrent = currentlyRunning;
        }
        await sleep(10);
        currentlyRunning--;
        return item;
      },
      0,
    );

    expect(maxConcurrent).toBe(1);
  });

  it('applies delay between items (not after last)', async () => {
    const timestamps: number[] = [];

    await processSequentially(
      [1, 2, 3],
      async (item) => {
        timestamps.push(Date.now());
        return item;
      },
      50,
    );

    // Second item should start at least ~50ms after first
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(30);
    // Third item should start at least ~50ms after second
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(30);
  });

  it('defaults to 500ms delay', async () => {
    // We'll verify the function signature accepts no delay parameter
    // and still works (just with a longer default delay)
    // For speed, we'll only process 1 item (no delay applied after last)
    const results = await processSequentially(
      [42],
      async (item) => item + 1,
    );
    expect(results).toEqual([43]);
  });

  it('handles zero delay', async () => {
    const start = Date.now();
    await processSequentially(
      [1, 2, 3, 4, 5],
      async (item) => item,
      0,
    );
    const elapsed = Date.now() - start;
    // Should be fast with zero delay
    expect(elapsed).toBeLessThan(200);
  });

  it('propagates errors from the processor', async () => {
    await expect(
      processSequentially(
        [1, 2, 3],
        async (item) => {
          if (item === 2) throw new Error('sequential failed');
          return item;
        },
        0,
      ),
    ).rejects.toThrow('sequential failed');
  });

  it('stops processing after error (sequential guarantee)', async () => {
    const processed: number[] = [];

    await processSequentially(
      [1, 2, 3],
      async (item) => {
        processed.push(item);
        if (item === 2) throw new Error('stop');
        return item;
      },
      0,
    ).catch(() => {});

    // Item 3 should NOT be processed because item 2 threw
    expect(processed).toEqual([1, 2]);
  });
});
