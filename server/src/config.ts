import dotenv from 'dotenv';
import path from 'path';

// Load .env file from server root if not already loaded
// Note: In this monorepo structure, CWD is often root, but we should be safe
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Retry configuration type (matches common/retry.ts RetryConfig without operationName)
interface RetryPreset {
  maxRetries: number;
  baseMultiplier: number; // seconds
  minWait: number; // seconds
}

export const REALM_CONFIG = {
  models: {
    // Default to LiteLLM-compatible models
    // In production, these are injected by forge-sentinel via env vars
    markdown: process.env.MARKDOWN_MODEL || 'gemini-2.5-flash',
    intermediate: process.env.INTERMEDIATE_MODEL || 'gemini-3-pro-preview',
    html: process.env.HTML_MODEL || 'gemini-3-flash-preview',
    // Agentic Doctor model - uses the most capable model for complex medical analysis
    // Falls back to INTERMEDIATE_MODEL which is typically a capable model
    doctor: process.env.DOCTOR_MODEL || process.env.INTERMEDIATE_MODEL || 'gemini-3-pro-preview',
  },
  agenticLoop: {
    // Maximum iterations for the agentic loop (tool calls + refinements)
    maxIterations: parseInt(process.env.MAX_AGENTIC_ITERATIONS || '10'),
    // Enable/disable web search for medical knowledge
    enableWebSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
  },
  retry: {
    // LLM calls: generous retries for expensive operations
    llm: {
      maxRetries: 8,
      baseMultiplier: 10, // seconds
      minWait: 0.5, // seconds
    } satisfies RetryPreset,
    // API calls: moderate retries
    api: {
      maxRetries: 3,
      baseMultiplier: 5,
      minWait: 0.5,
    } satisfies RetryPreset,
    // Vision API calls: balance between LLM and API
    vision: {
      maxRetries: 5,
      baseMultiplier: 5,
      minWait: 0.5,
    } satisfies RetryPreset,
  },
  throttle: {
    // PDF page extraction: process pages with rate limiting
    pdfExtraction: {
      maxConcurrent: parseInt(process.env.PDF_BATCH_SIZE || '4'),
      delayBetweenBatchesMs: parseInt(process.env.PDF_BATCH_DELAY_MS || '500'),
      delayBetweenRequestsMs: parseInt(process.env.PDF_REQUEST_DELAY_MS || '100'),
    },
    // Web search: rate limit search requests
    webSearch: {
      maxConcurrent: parseInt(process.env.SEARCH_BATCH_SIZE || '3'),
      delayBetweenBatchesMs: parseInt(process.env.SEARCH_BATCH_DELAY_MS || '500'),
      delayBetweenRequestsMs: parseInt(process.env.SEARCH_REQUEST_DELAY_MS || '250'),
    },
    // General LLM calls: default throttle for any batched LLM operations
    llm: {
      maxConcurrent: parseInt(process.env.LLM_BATCH_SIZE || '3'),
      delayBetweenBatchesMs: parseInt(process.env.LLM_BATCH_DELAY_MS || '800'),
      delayBetweenRequestsMs: parseInt(process.env.LLM_REQUEST_DELAY_MS || '150'),
    },
  },
  compression: {
    // Chat history compression: adapted from Gemini CLI's chatCompressionService
    // Triggers when conversation history exceeds threshold % of token limit
    threshold: parseFloat(process.env.COMPRESSION_THRESHOLD || '0.5'),
    // Fraction of recent history to preserve (rest gets compressed into a summary)
    preserveFraction: parseFloat(process.env.COMPRESSION_PRESERVE || '0.3'),
    // Token limit for the doctor model (gemini-3-pro-preview = 1M tokens)
    tokenLimit: parseInt(process.env.COMPRESSION_TOKEN_LIMIT || '1048576'),
  },
};
