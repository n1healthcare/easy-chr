/**
 * N1 Interface - Job Runner (Ephemeral K8s Job Mode)
 *
 * This entry point runs as a Kubernetes Job spawned by forge-sentinel.
 * It fetches PDFs, processes them through the Agentic Doctor pipeline,
 * and uploads the result to AWS S3.
 *
 * Environment Variables (injected by forge-sentinel):
 * - USER_ID: User identifier for PDF fetching
 * - CHR_ID: Unique identifier for this report generation
 * - CHR_FILENAME: User-specified filename for the report (optional, defaults to 'report')
 * - REPORT_PROMPT: User's analysis prompt (optional, defaults to generic prompt)
 * - N1_API_BASE_URL: N1 API backend URL
 * - N1_API_KEY: Authentication key for N1 API
 * - OPENAI_API_KEY: LiteLLM API key (converted to GEMINI_API_KEY internally)
 * - OPENAI_BASE_URL: LiteLLM proxy URL (converted to GOOGLE_GEMINI_BASE_URL internally)
 * - STORAGE_PROVIDER: 'local' | 's3' (default: 's3' in production)
 * - BUCKET_NAME: S3 bucket for output storage
 * - AWS_REGION: AWS region (default: 'us-east-2')
 *
 * Note: OPENAI_API_KEY and OPENAI_BASE_URL are automatically converted to
 * GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL at startup for compatibility.
 *
 * Environment-based feature flags:
 * - ENVIRONMENT: 'development' | 'staging' | 'production' (default: production)
 *   - development: Skips S3 upload and progress tracking
 *   - staging/production: Full pipeline with uploads and tracking
 */

// Initialize OTEL first (must be before other imports for auto-instrumentation)
import { setupOtel } from './otel.js';
try { setupOtel(); } catch { /* OTEL is optional — never crash */ }

import dotenv from 'dotenv';

// Load environment variables from .env file (if present)
dotenv.config();

// Convert standard OPENAI env vars to Gemini-specific ones
// This allows forge-sentinel to be agnostic about Gemini
// OPENAI_API_KEY takes priority - if present, it overwrites GEMINI_API_KEY
if (process.env.OPENAI_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.OPENAI_API_KEY;
} else if (!process.env.GEMINI_API_KEY) {
  // Neither is set - let the service throw the error
  console.warn('Warning: Neither OPENAI_API_KEY nor GEMINI_API_KEY is set');
}

// OPENAI_BASE_URL takes priority - if present, it overwrites GOOGLE_GEMINI_BASE_URL
if (process.env.OPENAI_BASE_URL) {
  // Strip /v1 suffix for Gemini
  const baseUrl = process.env.OPENAI_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  process.env.GOOGLE_GEMINI_BASE_URL = baseUrl;
} else if (!process.env.GOOGLE_GEMINI_BASE_URL) {
  // Neither is set - let the service throw the error
  console.warn('Warning: Neither OPENAI_BASE_URL nor GOOGLE_GEMINI_BASE_URL is set');
}

// Set billing headers for LiteLLM cost tracking via vendored gemini-cli
// Format: "Header1:Value1,Header2:Value2" (comma-separated)
// These headers are extracted by the n1-litellm billing callback
if (process.env.USER_ID) {
  const billingHeaders = [
    `x-subject-user-id:${process.env.USER_ID}`,
    `x-chr-id:${process.env.CHR_ID || ''}`,
    `x-service-name:workflow-easy-chr`,
  ].join(',');
  process.env.GEMINI_CLI_CUSTOM_HEADERS = billingHeaders;
}

import { GeminiAdapter } from './adapters/gemini/gemini.adapter.js';
import { N1ApiAdapter } from './adapters/n1-api/n1-api.adapter.js';
import { AgenticDoctorUseCase } from './application/use-cases/agentic-doctor.use-case.js';
import { FetchAndProcessPDFsUseCase } from './application/use-cases/fetch-and-process-pdfs.use-case.js';
import { RetryableError, ValidationError } from './common/exceptions.js';
import { withRetry } from './common/retry.js';
import { REALM_CONFIG } from './config.js';
import { createStorageAdapterFromEnv } from './adapters/storage/storage.factory.js';
import { PrefixedStorageAdapter } from './adapters/storage/prefixed-storage.adapter.js';
import { LegacyPaths, ProductionPaths } from './common/storage-paths.js';
import type { StoragePort } from './application/ports/storage.port.js';
import { getLogger, createChildLogger, type AppLogger } from './logger.js';
import path from 'path';
import fs from 'fs';

const rootLogger = getLogger();

// ============================================================================
// Environment Configuration
// ============================================================================

type Environment = 'development' | 'staging' | 'production';

function getEnvironment(): Environment {
  const env = process.env.ENVIRONMENT?.toLowerCase();
  if (env === 'development' || env === 'dev') return 'development';
  if (env === 'staging') return 'staging';
  return 'production';
}

const ENVIRONMENT = getEnvironment();
const IS_DEVELOPMENT = ENVIRONMENT === 'development';
const SKIP_UPLOADS = IS_DEVELOPMENT;
const SKIP_PROGRESS_TRACKING = IS_DEVELOPMENT;
const MIN_STORAGE_WRITE_RETRIES = 5;
const MIN_SIGNED_URL_RETRIES = 3;
const MIN_STORAGE_READ_RETRIES = 3;
const MIN_STORAGE_EXISTS_RETRIES = 3;

// ============================================================================
// Blindspot Feedback Widget (staging only)
// ============================================================================

function injectBlindspotWidget(html: string): string {
  if (ENVIRONMENT !== 'staging') return html;

  try {
    const widget = `<!-- Blindspot: n1healthcare/easy-chr -->
  <script async src="https://pub-566620c016dc4a40b7335d3f5e387a0e.r2.dev/blindspot.min.js"></script>
  <script>
    (function initializeBlindspot() {
      var maxRetries = 10;
      var retryCount = 0;
      var retryDelay = 500;

      function tryInitialize() {
        if (typeof Blindspot !== 'undefined' && Blindspot.init) {
          try {
            Blindspot.init({
              siteId: 'f3739d9a-fbb0-403c-a1f2-52fcc0203a23',
              color: '#1B6971',
              text: 'Report issue'
            });
          } catch (e) {
            console.error('[Blindspot] Initialization failed:', e.message);
          }
        } else if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(tryInitialize, retryDelay);
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInitialize);
      } else {
        setTimeout(tryInitialize, 100);
      }
      window.addEventListener('load', tryInitialize);
    })();
  </script>`;

    const idx = html.lastIndexOf('</body>');
    if (idx === -1) return html + widget;
    return html.slice(0, idx) + widget + '\n' + html.slice(idx);
  } catch {
    console.warn('[Blindspot] Failed to inject widget, returning original HTML');
    return html;
  }
}

// ============================================================================
// Progress Notification via N1 API
// ============================================================================

type ProgressStage =
  | 'Preparing'
  | 'Analyzing'
  | 'Writing'
  | 'Checking'
  | 'Finalizing'
  | 'Complete'
  | 'Has Error';

interface ProgressUpdate {
  stage: ProgressStage;
  progress: number;  // 0-100
  message: string;
  errorDetails?: string; // user-facing error message
  errorCode?: string; // structured error code (operation:transport_error)
}

// Map our pipeline steps to N1 API progress stages
const PROGRESS_MAP: Record<string, ProgressUpdate> = {
  initializing:      { stage: 'Preparing',  progress: 5,   message: 'Setting up AI pipeline...' },
  fetching_records:  { stage: 'Preparing',  progress: 15,  message: 'Retrieving your medical records...' },
  analyzing:         { stage: 'Analyzing',  progress: 30,  message: 'Analyzing your health data...' },
  generating_report: { stage: 'Writing',    progress: 60,  message: 'Building your health report...' },
  uploading:         { stage: 'Finalizing', progress: 85,  message: 'Saving your report...' },
  completed:         { stage: 'Complete',   progress: 100, message: 'Your health report is ready!' },
  failed:            { stage: 'Has Error',  progress: 0,   message: 'Report generation failed' },
};

const OPERATION_BY_STEP: Record<keyof typeof PROGRESS_MAP, string> = {
  initializing: 'internal',
  fetching_records: 'data_fetch',
  analyzing: 'analysis',
  generating_report: 'report_generation',
  uploading: 'file_upload',
  completed: 'report_generation',
  failed: 'report_generation',
};

// Map AgenticDoctorUseCase phase names to progress updates
// These phases are yielded as { type: 'step', name: '...', status: 'running'|'completed'|'failed' }
const PHASE_PROGRESS_MAP: Record<string, ProgressUpdate> = {
  'Document Extraction':    { stage: 'Preparing',  progress: 15,  message: 'Extracting content from your documents...' },
  'Medical Analysis':       { stage: 'Analyzing',  progress: 30,  message: 'Performing medical analysis...' },
  'Research':               { stage: 'Analyzing',  progress: 45,  message: 'Researching and validating claims...' },
  'Data Structuring':       { stage: 'Writing',    progress: 55,  message: 'Structuring data for visualization...' },
  'Validation':             { stage: 'Checking',   progress: 65,  message: 'Validating analysis completeness...' },
  'Realm Generation':       { stage: 'Finalizing', progress: 80,  message: 'Building your interactive health realm...' },
  'Content Review':         { stage: 'Checking',   progress: 90,  message: 'Reviewing content completeness...' },
  'HTML Regeneration':      { stage: 'Finalizing', progress: 95,  message: 'Refining the health realm...' },
};

// ============================================================================
// Exit Codes + Error Classification
// ============================================================================

enum WorkflowExitCode {
  SUCCESS = 0,
  RETRYABLE = 1,
  NON_RETRYABLE = 2,
  INSUFFICIENT_DATA = 3,
  BILLING_ERROR = 5,
  VALIDATION_ERROR = 7,
}

interface ErrorInfo {
  exitCode: WorkflowExitCode;
  errorCode: string;
  message: string;
  retryable: boolean;
  userMessage: string;
}

function classifyError(error: Error): ErrorInfo {
  const errorName = error.constructor.name;
  const errorMessage = error.message.toLowerCase();
  const statusCode = (() => {
    const statusCandidate = (error as { status?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode
      ?? (error as { response?: { status?: unknown } }).response?.status;

    if (typeof statusCandidate === 'number') {
      return statusCandidate;
    }
    if (typeof statusCandidate === 'string') {
      const parsed = Number(statusCandidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    const match = errorMessage.match(/(?:status[:\s]*|\()(\d{3})\b/);
    if (match) {
      return Number(match[1]);
    }

    return undefined;
  })();

  if (error instanceof ValidationError) {
    return {
      exitCode: WorkflowExitCode.VALIDATION_ERROR,
      errorCode: 'validation:invalid_input',
      message: error.message,
      retryable: false,
      userMessage: 'Invalid input or configuration detected.',
    };
  }

  if (error instanceof RetryableError) {
    return {
      exitCode: WorkflowExitCode.RETRYABLE,
      errorCode: 'internal:unknown',
      message: error.message,
      retryable: true,
      userMessage: 'A temporary error occurred. Please try again.',
    };
  }

  // Rate limiting
  if (errorName.includes('RateLimit') || errorMessage.includes('rate limit') || errorMessage.includes('429')) {
    return {
      exitCode: WorkflowExitCode.RETRYABLE,
      errorCode: 'llm_service:rate_limited',
      message: 'Service is busy, will retry',
      retryable: true,
      userMessage: 'Service is busy, please try again shortly.',
    };
  }

  // Billing / insufficient funds
  if (statusCode === 402 || (errorMessage.includes('insufficient') && errorMessage.includes('fund'))) {
    return {
      exitCode: WorkflowExitCode.BILLING_ERROR,
      errorCode: 'billing:insufficient_funds',
      message: error.message,
      retryable: false,
      userMessage: 'Billing issue detected. Please add credits and try again.',
    };
  }

  // Validation
  if (
    errorMessage.includes('validation') ||
    errorMessage.includes('invalid') ||
    errorMessage.includes('missing required environment variables') ||
    errorMessage.includes('missing s3 environment variable')
  ) {
    return {
      exitCode: WorkflowExitCode.VALIDATION_ERROR,
      errorCode: 'validation:invalid_input',
      message: error.message,
      retryable: false,
      userMessage: 'Invalid input or configuration detected.',
    };
  }

  // Insufficient data
  if (errorMessage.includes('insufficient') && errorMessage.includes('data')) {
    return {
      exitCode: WorkflowExitCode.INSUFFICIENT_DATA,
      errorCode: 'data_validation:insufficient_data',
      message: error.message,
      retryable: false,
      userMessage: 'Insufficient data provided for analysis.',
    };
  }

  // Timeout
  if (errorName.includes('Timeout') || errorMessage.includes('timeout')) {
    return {
      exitCode: WorkflowExitCode.RETRYABLE,
      errorCode: 'llm_service:timeout',
      message: 'Request timed out, will retry',
      retryable: true,
      userMessage: 'Request timed out. Please try again.',
    };
  }

  // Default: retryable
  return {
    exitCode: WorkflowExitCode.RETRYABLE,
    errorCode: 'internal:unknown',
    message: error.message,
    retryable: true,
    userMessage: 'An unexpected error occurred. Please try again.',
  };
}

async function notifyProgress(
  config: { n1ApiBaseUrl: string; n1ApiKey: string; userId: string; chrId: string },
  step: keyof typeof PROGRESS_MAP,
  technicalMessage?: string,
  errorDetails?: string,
  errorCode?: string
): Promise<void> {
  const update = PROGRESS_MAP[step];
  if (!update) {
    rootLogger.warn({ step }, 'Unknown progress step');
    return;
  }

  rootLogger.info({ stage: update.stage, progress: update.progress }, technicalMessage || update.message);

  // Skip API calls in development
  if (SKIP_PROGRESS_TRACKING) {
    rootLogger.debug({ environment: ENVIRONMENT }, 'Skipping progress API call');
    return;
  }

  const isError = step === 'failed';
  const derivedErrorCode = `${OPERATION_BY_STEP[step]}:unknown`;

  const payload: Record<string, unknown> = {
    report_id: config.chrId,
    user_id: config.userId,
    progress: update.progress,
    status: isError ? 'error' : (step === 'completed' ? 'completed' : 'in_progress'),
    message: technicalMessage || update.message,
    progress_stage: update.stage,
  };

  if (isError) {
    payload.error = errorCode || derivedErrorCode;
    payload.error_details = errorDetails || update.message;
  }

  try {
    const response = await fetch(`${config.n1ApiBaseUrl}/reports/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'N1-Api-Key': config.n1ApiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      rootLogger.warn({ statusCode: response.status }, `Progress API call failed: ${await response.text()}`);
    }
  } catch (error) {
    // Don't fail the job if progress update fails - just log it
    rootLogger.warn(error, 'Progress API error');
  }
}

/**
 * Send phase-specific progress update with granular percentage
 * This supplements notifyProgress by using PHASE_PROGRESS_MAP values
 */
async function notifyPhaseProgress(
  config: { n1ApiBaseUrl: string; n1ApiKey: string; userId: string; chrId: string },
  phaseName: string
): Promise<void> {
  const update = PHASE_PROGRESS_MAP[phaseName];
  if (!update) {
    rootLogger.warn({ phaseName }, 'Unknown phase progress');
    return;
  }

  rootLogger.info({ stage: update.stage, progress: update.progress, phase: phaseName }, update.message);

  // Skip API calls in development
  if (SKIP_PROGRESS_TRACKING) {
    rootLogger.debug({ environment: ENVIRONMENT }, 'Skipping phase progress API call');
    return;
  }

  const payload: Record<string, unknown> = {
    report_id: config.chrId,
    user_id: config.userId,
    progress: update.progress,
    status: 'in_progress',
    message: update.message,
    progress_stage: update.stage,
  };

  try {
    const response = await fetch(`${config.n1ApiBaseUrl}/reports/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'N1-Api-Key': config.n1ApiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      rootLogger.warn({ statusCode: response.status }, `Phase progress API call failed: ${await response.text()}`);
    }
  } catch (error) {
    // Don't fail the job if progress update fails - just log it
    rootLogger.warn(error, 'Phase progress API error');
  }
}

dotenv.config();

interface JobConfig {
  userId: string;
  chrId: string;
  chrFilename?: string;  // User-specified filename from UI
  prompt: string;
  n1ApiBaseUrl: string;
  n1ApiKey: string;
  // S3 config - optional in development
  bucketName?: string;
  awsRegion?: string;
}

function validateEnvironment(): JobConfig {
  // Core required fields (always needed)
  const coreRequired = {
    USER_ID: process.env.USER_ID,
    CHR_ID: process.env.CHR_ID,
    N1_API_BASE_URL: process.env.N1_API_BASE_URL,
    N1_API_KEY: process.env.N1_API_KEY,
  };

  // S3 fields - only required in staging/production
  const s3Fields = {
    BUCKET_NAME: process.env.BUCKET_NAME,
    AWS_REGION: process.env.AWS_REGION || 'us-east-2',  // Default region
  };

  // Check core required fields
  const missingCore = Object.entries(coreRequired)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missingCore.length > 0) {
    throw new Error(`Missing required environment variables: ${missingCore.join(', ')}`);
  }

  // Check S3 fields only if uploads are enabled
  if (!SKIP_UPLOADS) {
    const storageProvider = process.env.STORAGE_PROVIDER ?? 'local';
    if (storageProvider !== 's3') {
      throw new Error(
        `STORAGE_PROVIDER must be 's3' for ${ENVIRONMENT} (currently: '${storageProvider}'). ` +
        `Set STORAGE_PROVIDER=s3 to enable S3 uploads.`
      );
    }
    if (!s3Fields.BUCKET_NAME) {
      throw new Error(`Missing S3 environment variable BUCKET_NAME (required for ${ENVIRONMENT})`);
    }
  }

  return {
    userId: coreRequired.USER_ID!,
    chrId: coreRequired.CHR_ID!,
    chrFilename: process.env.CHR_FILENAME || undefined,
    // Accept REPORT_PROMPT (forge-sentinel uses report_prompt parameter)
    prompt: process.env.REPORT_PROMPT || 'Create a comprehensive health analysis and visualization of my medical records',
    // Remove trailing slash to prevent double-slash URLs (e.g., /api//reports/status)
    n1ApiBaseUrl: coreRequired.N1_API_BASE_URL!.replace(/\/+$/, ''),
    n1ApiKey: coreRequired.N1_API_KEY!,
    bucketName: s3Fields.BUCKET_NAME || undefined,
    awsRegion: s3Fields.AWS_REGION || undefined,
  };
}

async function runJob() {
  rootLogger.info({ startedAt: new Date().toISOString(), environment: ENVIRONMENT, skipUploads: SKIP_UPLOADS, skipProgressTracking: SKIP_PROGRESS_TRACKING }, 'N1 Interface - Job Runner starting');

  let config: JobConfig;
  try {
    config = validateEnvironment();
    rootLogger.info({ userId: config.userId, chrId: config.chrId, chrFilename: config.chrFilename }, 'Environment validated');
    rootLogger.debug({ prompt: config.prompt.substring(0, 80) }, 'Job prompt');
  } catch (error) {
    const errorInfo = classifyError(error as Error);
    rootLogger.error(error, 'Environment validation failed');

    // Try to notify failure even without full config (best effort)
    const partialConfig = {
      n1ApiBaseUrl: (process.env.N1_API_BASE_URL || '').replace(/\/+$/, ''),
      n1ApiKey: process.env.N1_API_KEY || '',
      userId: process.env.USER_ID || '',
      chrId: process.env.CHR_ID || '',
    };

    // Only notify if we have the minimum required fields
    if (partialConfig.n1ApiBaseUrl && partialConfig.n1ApiKey && partialConfig.chrId) {
      await notifyProgress(
        partialConfig,
        'failed',
        'Environment validation failed',
        errorInfo.userMessage || (error as Error).message,
        errorInfo.errorCode
      );
    } else {
      rootLogger.error('Cannot notify API - missing N1_API_BASE_URL, N1_API_KEY, or CHR_ID');
    }

    process.exit(errorInfo.exitCode);
  }

  // Create a child logger with correlation IDs for the rest of the job
  const logger = createChildLogger({
    chrId: config.chrId,
    userId: config.userId,
  });

  let realmPath: string | null = null;

  try {
    // Step 1: Initialize Gemini adapter and storage
    await notifyProgress(config, 'initializing', `Setting up AI pipeline for report id ${config.chrId}`);
    logger.info('[1/5] Initializing Gemini adapter and storage...');
    const geminiAdapter = new GeminiAdapter();
    await geminiAdapter.initialize();

    // Create storage adapters:
    // - baseStorage: raw S3/local adapter for production paths (users/{userId}/chr/...)
    // - scopedStorage: prefixed adapter for pipeline files (users/{userId}/easychr_files/...)
    const baseStorage = createStorageAdapterFromEnv();
    const intermediatesPrefix = `users/${config.userId}/easychr_files`;
    const scopedStorage = new PrefixedStorageAdapter(baseStorage, intermediatesPrefix);
    const storageProvider = process.env.STORAGE_PROVIDER ?? 'local';
    const bucketName = process.env.BUCKET_NAME ?? '(none)';
    logger.info({ storageProvider, bucketName, intermediatesPrefix }, 'Gemini adapter and storage ready');

    // Step 2: Initialize Agentic Doctor with scoped storage
    // All pipeline files (extracted.md, analysis.md, etc.) go under users/{userId}/easychr_files/
    logger.info('[2/5] Initializing Agentic Doctor pipeline...');
    const agenticDoctorUseCase = new AgenticDoctorUseCase(geminiAdapter, scopedStorage);
    agenticDoctorUseCase.setBillingContext({
      userId: config.userId,
      chrId: config.chrId,
    });
    await agenticDoctorUseCase.initialize();
    logger.info('Agentic Doctor ready');

    // Step 3: Initialize N1 API adapter and fetch PDFs
    await notifyProgress(config, 'fetching_records');
    logger.info('[3/5] Fetching PDFs from N1 API...');
    const n1ApiAdapter = new N1ApiAdapter(config.n1ApiBaseUrl, config.n1ApiKey);
    const fetchAndProcessUseCase = new FetchAndProcessPDFsUseCase(n1ApiAdapter, agenticDoctorUseCase);

    // Step 4: Process PDFs through pipeline
    await notifyProgress(config, 'analyzing');
    logger.info('[4/5] Processing PDFs through multi-agent pipeline...');
    const generator = fetchAndProcessUseCase.execute(config.userId, config.prompt);

    for await (const event of generator) {
      if (event.type === 'step') {
        // Handle phase progress updates from AgenticDoctorUseCase
        const phaseName = 'name' in event ? event.name : '';
        const phaseStatus = 'status' in event ? event.status : '';

        if (phaseStatus === 'running' && phaseName && PHASE_PROGRESS_MAP[phaseName]) {
          logger.info({ phase: phaseName, status: 'running' }, `Phase started: ${phaseName}`);
          // Send granular progress update to N1 API
          await notifyPhaseProgress(config, phaseName);
        } else if (phaseStatus === 'completed') {
          logger.info({ phase: phaseName, status: 'completed' }, `Phase completed: ${phaseName}`);
        } else if (phaseStatus === 'failed') {
          logger.error({ phase: phaseName, status: 'failed' }, `Phase failed: ${phaseName}`);
        }
      } else if (event.type === 'thought') {
        logger.debug({ eventType: 'thought' }, `${'content' in event ? event.content : ''}`);
      } else if (event.type === 'log') {
        logger.info({ eventType: 'log' }, `${'message' in event ? event.message : ''}`);
      } else if (event.type === 'result') {
        realmPath = 'url' in event ? event.url : '';
        logger.info({ realmPath }, 'Realm generated');
      } else if (event.type === 'error') {
        const errorMsg = 'content' in event ? event.content : 'Unknown error';
        logger.error({ eventType: 'error' }, errorMsg);
        throw new Error(errorMsg);
      }
    }

    if (!realmPath) {
      throw new Error('No realm was generated');
    }

    await notifyProgress(config, 'generating_report');
    logger.info('Processing complete');

    // Extract realm ID from path and read HTML from storage
    // realmPath format: "/realms/<uuid>/index.html"
    const realmId = realmPath.replace('/realms/', '').replace('/index.html', '');
    const storagePath = LegacyPaths.realm(realmId);

    // Check if HTML exists in scoped storage (where the pipeline wrote it)
    const htmlExists = await scopedStorage.exists(storagePath);
    if (!htmlExists) {
      throw new Error(`Generated HTML not found at: ${intermediatesPrefix}/${storagePath}`);
    }

    let publicUrl = storagePath; // Default to storage path

    // Step 5: Upload to production path and get signed URL (skip in development)
    if (SKIP_UPLOADS) {
      logger.info({ storagePath, environment: ENVIRONMENT }, '[5/5] Skipping production upload (development)');
    } else {
      await notifyProgress(config, 'uploading');
      logger.info('[5/5] Copying to production path and generating signed URL...');

      // Read HTML from scoped storage (where the pipeline wrote it)
      let htmlContent = await withRetry(
        () => scopedStorage.readFileAsString(storagePath),
        {
          ...REALM_CONFIG.retry.api,
          maxRetries: Math.max(REALM_CONFIG.retry.api.maxRetries, MIN_STORAGE_READ_RETRIES),
          operationName: 'Storage.readFileAsString',
        }
      );

      // Inject Blindspot feedback widget (staging only)
      htmlContent = injectBlindspotWidget(htmlContent);

      // Build production path: users/{userId}/chr/{chrId}/{filename}.html
      const rawFilename = config.chrFilename || 'report';
      const filename = path.basename(rawFilename, path.extname(rawFilename)) || 'report';
      const prodPath = ProductionPaths.userChr(config.userId, config.chrId, `${filename}.html`);

      // Write to production path using baseStorage (not scoped)
      logger.info({ prodPath }, 'Writing to production path');
      await withRetry(
        () => baseStorage.writeFile(prodPath, htmlContent, 'text/html'),
        {
          ...REALM_CONFIG.retry.api,
          maxRetries: Math.max(REALM_CONFIG.retry.api.maxRetries, MIN_STORAGE_WRITE_RETRIES),
          operationName: 'Storage.writeFile',
        }
      );

      // Verify the file was written successfully
      const writeVerified = await withRetry(
        async () => {
          const exists = await baseStorage.exists(prodPath);
          if (!exists) {
            throw new RetryableError(`Storage.exists returned false for ${prodPath}`);
          }
          return true;
        },
        {
          ...REALM_CONFIG.retry.api,
          maxRetries: Math.max(REALM_CONFIG.retry.api.maxRetries, MIN_STORAGE_EXISTS_RETRIES),
          operationName: 'Storage.exists',
        }
      );
      if (!writeVerified) {
        throw new Error(`Failed to verify write to storage: ${prodPath}`);
      }
      logger.info({ prodPath }, 'Write verified');

      // Get signed URL for access
      publicUrl = await withRetry(
        () => baseStorage.getSignedUrl(prodPath),
        {
          ...REALM_CONFIG.retry.api,
          maxRetries: Math.max(REALM_CONFIG.retry.api.maxRetries, MIN_SIGNED_URL_RETRIES),
          operationName: 'Storage.getSignedUrl',
        }
      );

      logger.info({ prodPath }, 'Uploaded to production');
    }

    // Success - notify completion
    await notifyProgress(config, 'completed');
    logger.info({ finishedAt: new Date().toISOString(), outputUrl: publicUrl }, 'Job completed successfully');

    process.exit(0);

  } catch (error) {
    // Notify failure
    const errorInfo = classifyError(error as Error);
    const progressMessage = errorInfo.userMessage || 'An unexpected error occurred.';

    await notifyProgress(
      config,
      'failed',
      progressMessage,
      errorInfo.userMessage,
      errorInfo.errorCode
    );

    logger.error({
      failedAt: new Date().toISOString(),
      errorCode: errorInfo.errorCode,
      retryable: errorInfo.retryable,
      exitCode: errorInfo.exitCode,
      err: error,
    }, 'Job failed');

    process.exit(errorInfo.exitCode);
  }
}

// Run the job
runJob();
