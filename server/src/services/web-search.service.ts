/**
 * Web Search Service
 *
 * Provides web search/grounding capability using Gemini's native googleSearch tool.
 * Returns search results with sources for fact-checking and current information.
 */

import { Config } from '../../vendor/gemini-cli/packages/core/src/config/config.js';
import { REALM_CONFIG } from '../config.js';
import { processSequentially } from '../common/index.js';

export interface WebSearchSource {
  title: string;
  uri: string;
}

export interface WebSearchResult {
  text: string;
  queries: string[];
  sources: WebSearchSource[];
}

/**
 * Performs a web search using Gemini's grounding capability.
 *
 * @param config - Initialized Gemini Config object
 * @param query - The search query or question to answer
 * @param options - Optional configuration
 * @returns Search result with text, queries used, and sources
 *
 * @example
 * ```typescript
 * const result = await webSearch(config, 'What is the current population of Tokyo?');
 * console.log(result.text);       // "The population of Tokyo is..."
 * console.log(result.sources);    // [{ title: "...", uri: "..." }]
 * ```
 */
export async function webSearch(
  config: Config,
  query: string,
  options?: {
    maxTokens?: number;
    signal?: AbortSignal;
  }
): Promise<WebSearchResult> {
  const geminiClient = config.getGeminiClient();
  const signal = options?.signal || new AbortController().signal;

  const response = await geminiClient.generateContent(
    { model: 'web-search' },
    [{ role: 'user', parts: [{ text: query }] }],
    signal
  );

  // Extract response text
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract grounding metadata
  const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
  const queries = groundingMetadata?.webSearchQueries || [];

  // Extract sources
  const groundingChunks = groundingMetadata?.groundingChunks || [];
  const sources: WebSearchSource[] = groundingChunks
    .filter((chunk: any) => chunk.web)
    .map((chunk: any) => ({
      title: chunk.web.title || 'Untitled',
      uri: chunk.web.uri || ''
    }));

  return { text, queries, sources };
}

/**
 * Formats web search results as markdown with citations.
 *
 * @param result - WebSearchResult from webSearch()
 * @returns Formatted markdown string with inline citations and source list
 */
export function formatWebSearchAsMarkdown(result: WebSearchResult): string {
  let markdown = result.text;

  if (result.sources.length > 0) {
    markdown += '\n\n---\n\n**Sources:**\n';
    result.sources.forEach((source, index) => {
      markdown += `${index + 1}. [${source.title}](${source.uri})\n`;
    });
  }

  return markdown;
}

/**
 * Performs multiple web searches sequentially with rate limiting.
 * Useful for comprehensive research on a topic without overwhelming the API.
 *
 * @param config - Initialized Gemini Config object
 * @param queries - Array of search queries
 * @returns Combined results with deduplicated sources
 */
export async function webSearchMultiple(
  config: Config,
  queries: string[]
): Promise<{
  results: WebSearchResult[];
  allSources: WebSearchSource[];
}> {
  const throttle = REALM_CONFIG.throttle.webSearch;

  // Process searches sequentially with delay to avoid rate limits
  const results = await processSequentially(
    queries,
    async (query) => webSearch(config, query),
    throttle.delayBetweenRequestsMs
  );

  // Deduplicate sources by URI
  const seenUris = new Set<string>();
  const allSources: WebSearchSource[] = [];

  for (const result of results) {
    for (const source of result.sources) {
      if (!seenUris.has(source.uri)) {
        seenUris.add(source.uri);
        allSources.push(source);
      }
    }
  }

  return { results, allSources };
}
