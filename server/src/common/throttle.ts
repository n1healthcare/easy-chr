/**
 * Throttle utility for rate-limiting API calls.
 *
 * Provides utilities to prevent overwhelming external APIs with too many
 * concurrent or rapid requests.
 */

// ============================================================================
// Types
// ============================================================================

export interface ThrottleConfig {
  /** Maximum concurrent requests */
  maxConcurrent: number;
  /** Delay between batches in milliseconds */
  delayBetweenBatchesMs: number;
  /** Delay between individual requests in milliseconds */
  delayBetweenRequestsMs: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process items in batches with rate limiting.
 *
 * @param items - Array of items to process
 * @param processor - Async function to process each item
 * @param config - Throttle configuration
 * @returns Array of results in the same order as input items
 *
 * @example
 * ```typescript
 * const results = await processInBatches(
 *   urls,
 *   async (url) => fetch(url),
 *   { maxConcurrent: 3, delayBetweenBatchesMs: 1000, delayBetweenRequestsMs: 100 }
 * );
 * ```
 */
export async function processInBatches<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  config: ThrottleConfig
): Promise<R[]> {
  const results: R[] = [];

  for (let batchStart = 0; batchStart < items.length; batchStart += config.maxConcurrent) {
    const batchEnd = Math.min(batchStart + config.maxConcurrent, items.length);
    const batch = items.slice(batchStart, batchEnd);

    // Process batch with delays between individual requests
    const batchPromises = batch.map(async (item, indexInBatch) => {
      // Stagger requests within batch
      if (config.delayBetweenRequestsMs > 0 && indexInBatch > 0) {
        await sleep(config.delayBetweenRequestsMs * indexInBatch);
      }
      return processor(item, batchStart + indexInBatch);
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Delay between batches (except after the last batch)
    const isLastBatch = batchEnd >= items.length;
    if (!isLastBatch && config.delayBetweenBatchesMs > 0) {
      await sleep(config.delayBetweenBatchesMs);
    }
  }

  return results;
}

/**
 * Process items sequentially with a delay between each.
 * Use this for APIs that are very sensitive to rate limiting.
 *
 * @param items - Array of items to process
 * @param processor - Async function to process each item
 * @param delayMs - Delay between each request in milliseconds
 * @returns Array of results in the same order as input items
 */
export async function processSequentially<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  delayMs: number = 500
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = await processor(items[i], i);
    results.push(result);

    // Delay after each request (except the last)
    if (i < items.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return results;
}

/**
 * Generator version of processInBatches for streaming results.
 * Useful when you need to yield progress updates.
 */
export async function* processInBatchesWithProgress<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  config: ThrottleConfig
): AsyncGenerator<{ batchNumber: number; totalBatches: number; results: R[] }> {
  const totalBatches = Math.ceil(items.length / config.maxConcurrent);

  for (let batchStart = 0; batchStart < items.length; batchStart += config.maxConcurrent) {
    const batchEnd = Math.min(batchStart + config.maxConcurrent, items.length);
    const batch = items.slice(batchStart, batchEnd);
    const batchNumber = Math.floor(batchStart / config.maxConcurrent) + 1;

    // Process batch with delays between individual requests
    const batchPromises = batch.map(async (item, indexInBatch) => {
      if (config.delayBetweenRequestsMs > 0 && indexInBatch > 0) {
        await sleep(config.delayBetweenRequestsMs * indexInBatch);
      }
      return processor(item, batchStart + indexInBatch);
    });

    const results = await Promise.all(batchPromises);

    yield { batchNumber, totalBatches, results };

    // Delay between batches (except after the last batch)
    const isLastBatch = batchEnd >= items.length;
    if (!isLastBatch && config.delayBetweenBatchesMs > 0) {
      await sleep(config.delayBetweenBatchesMs);
    }
  }
}
