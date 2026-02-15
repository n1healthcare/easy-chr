import dotenv from 'dotenv';
import path from 'path';
import { RETRY_WAIT_UPPER_LIMIT_SECONDS } from './common/retry.constants.js';

// Load .env file from server root if not already loaded
// Note: In this monorepo structure, CWD is often root, but we should be safe
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Retry configuration type (matches common/retry.ts RetryConfig without operationName)
interface RetryPreset {
  maxRetries: number;
  baseMultiplier: number; // seconds
  minWait: number; // seconds
  maxWait: number; // seconds
}

function parseRetryMaxWait(value: string | undefined, fallbackSeconds: number): number {
  const parsed = Number(value);
  const effectiveValue = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return Math.min(effectiveValue, RETRY_WAIT_UPPER_LIMIT_SECONDS);
}

const DEFAULT_REALM_MODELS = {
  markdown: 'gemini-2.5-flash',
  intermediate: 'gemini-3-pro-preview',
  html: 'gemini-3-flash-preview',
  doctor: 'gemini-3-pro-preview',
} as const;

const MODEL_ENV_OVERRIDES = {
  MARKDOWN_MODEL: process.env.MARKDOWN_MODEL,
  INTERMEDIATE_MODEL: process.env.INTERMEDIATE_MODEL,
  HTML_MODEL: process.env.HTML_MODEL,
  DOCTOR_MODEL: process.env.DOCTOR_MODEL,
};

export const REALM_CONFIG = {
  models: {
    // Defaults-only model routing: env model overrides are ignored.
    markdown: DEFAULT_REALM_MODELS.markdown,
    intermediate: DEFAULT_REALM_MODELS.intermediate,
    html: DEFAULT_REALM_MODELS.html,
    doctor: DEFAULT_REALM_MODELS.doctor,
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
      maxWait: parseRetryMaxWait(process.env.LLM_RETRY_MAX_WAIT_SECONDS, 600),
    } satisfies RetryPreset,
    // API calls: moderate retries
    api: {
      maxRetries: 3,
      baseMultiplier: 5,
      minWait: 0.5,
      maxWait: parseRetryMaxWait(process.env.API_RETRY_MAX_WAIT_SECONDS, 120),
    } satisfies RetryPreset,
    // Vision API calls: balance between LLM and API
    vision: {
      maxRetries: 5,
      baseMultiplier: 5,
      minWait: 0.5,
      maxWait: parseRetryMaxWait(process.env.VISION_RETRY_MAX_WAIT_SECONDS, 180),
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
  langfuse: {
    enabled: ['true', '1', 'yes'].includes((process.env.OBSERVABILITY_ENABLED ?? 'false').toLowerCase()),
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
    host: process.env.LANGFUSE_HOST || 'https://langfuse.n1-research.com',
  },
};

export function getModelInventory(): {
  policy: 'defaults_only';
  resolvedModels: typeof DEFAULT_REALM_MODELS;
  ignoredEnvOverrides: Record<string, string>;
} {
  const ignoredEnvOverrides = Object.fromEntries(
    Object.entries(MODEL_ENV_OVERRIDES).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    ),
  ) as Record<string, string>;

  return {
    policy: 'defaults_only',
    resolvedModels: { ...DEFAULT_REALM_MODELS },
    ignoredEnvOverrides,
  };
}
