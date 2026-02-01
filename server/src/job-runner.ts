/**
 * N1 Interface - Job Runner (Ephemeral K8s Job Mode)
 *
 * This entry point runs as a Kubernetes Job spawned by forge-sentinel.
 * It fetches PDFs, processes them through the Agentic Doctor pipeline,
 * and uploads the result to Google Cloud Storage.
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
 * - BUCKET_NAME: GCS bucket for output storage
 * - PROJECT_ID: GCP project ID
 * - GCS_SERVICE_ACCOUNT_JSON: Service account credentials (JSON string)
 *
 * Note: OPENAI_API_KEY and OPENAI_BASE_URL are automatically converted to
 * GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL at startup for compatibility.
 *
 * Environment-based feature flags:
 * - ENVIRONMENT: 'development' | 'staging' | 'production' (default: production)
 *   - development: Skips GCS upload and progress tracking
 *   - staging/production: Full pipeline with uploads and tracking
 */

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
import { GcsStorageAdapter } from './adapters/gcs/gcs-storage.adapter.js';
import path from 'path';
import fs from 'fs';

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
  'Document Extraction':    { stage: 'Preparing',  progress: 20,  message: 'Extracting content from your documents...' },
  'Medical Analysis':       { stage: 'Analyzing',  progress: 30,  message: 'Performing medical analysis...' },
  'Cross-System Analysis':  { stage: 'Analyzing',  progress: 40,  message: 'Analyzing cross-system connections...' },
  'Research':               { stage: 'Analyzing',  progress: 50,  message: 'Researching and validating claims...' },
  'Synthesis':              { stage: 'Writing',    progress: 60,  message: 'Synthesizing your health report...' },
  'Validation':             { stage: 'Checking',   progress: 70,  message: 'Validating analysis completeness...' },
  'Data Structuring':       { stage: 'Writing',    progress: 80,  message: 'Structuring data for visualization...' },
  'Realm Generation':       { stage: 'Finalizing', progress: 90,  message: 'Building your interactive health realm...' },
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
      retryable: true,
      userMessage: 'Billing issue detected. Please add credits and try again.',
    };
  }

  // Validation
  if (
    errorMessage.includes('validation') ||
    errorMessage.includes('invalid') ||
    errorMessage.includes('missing required environment variables') ||
    errorMessage.includes('missing gcs environment variables')
  ) {
    return {
      exitCode: WorkflowExitCode.VALIDATION_ERROR,
      errorCode: 'validation:invalid_input',
      message: error.message,
      retryable: false,
      userMessage: error.message,
    };
  }

  // Insufficient data
  if (errorMessage.includes('insufficient') && errorMessage.includes('data')) {
    return {
      exitCode: WorkflowExitCode.INSUFFICIENT_DATA,
      errorCode: 'data_validation:insufficient_data',
      message: error.message,
      retryable: false,
      userMessage: error.message,
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
    console.log(`[Progress] Unknown step: ${step}`);
    return;
  }

  console.log(`[Progress] ${update.stage} (${update.progress}%): ${technicalMessage || update.message}`);

  // Skip API calls in development
  if (SKIP_PROGRESS_TRACKING) {
    console.log(`[Progress] Skipping API call (ENVIRONMENT=${ENVIRONMENT})`);
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
      console.warn(`[Progress] API call failed (${response.status}): ${await response.text()}`);
    }
  } catch (error) {
    // Don't fail the job if progress update fails - just log it
    console.warn(`[Progress] API error:`, error);
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
    console.log(`[Progress] Unknown phase: ${phaseName}`);
    return;
  }

  console.log(`[Progress] ${update.stage} (${update.progress}%): ${update.message}`);

  // Skip API calls in development
  if (SKIP_PROGRESS_TRACKING) {
    console.log(`[Progress] Skipping API call (ENVIRONMENT=${ENVIRONMENT})`);
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
      console.warn(`[Progress] API call failed (${response.status}): ${await response.text()}`);
    }
  } catch (error) {
    // Don't fail the job if progress update fails - just log it
    console.warn(`[Progress] API error:`, error);
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
  // GCS config - optional in development
  bucketName?: string;
  projectId?: string;
  gcsCredentials?: string;
}

function validateEnvironment(): JobConfig {
  // Core required fields (always needed)
  const coreRequired = {
    USER_ID: process.env.USER_ID,
    CHR_ID: process.env.CHR_ID,
    N1_API_BASE_URL: process.env.N1_API_BASE_URL,
    N1_API_KEY: process.env.N1_API_KEY,
  };

  // GCS fields - only required in staging/production
  const gcsFields = {
    BUCKET_NAME: process.env.BUCKET_NAME,
    PROJECT_ID: process.env.PROJECT_ID,
    GCS_SERVICE_ACCOUNT_JSON: process.env.GCS_SERVICE_ACCOUNT_JSON,
  };

  // Check core required fields
  const missingCore = Object.entries(coreRequired)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missingCore.length > 0) {
    throw new Error(`Missing required environment variables: ${missingCore.join(', ')}`);
  }

  // Check GCS fields only if uploads are enabled
  if (!SKIP_UPLOADS) {
    const missingGcs = Object.entries(gcsFields)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missingGcs.length > 0) {
      throw new Error(`Missing GCS environment variables (required for ${ENVIRONMENT}): ${missingGcs.join(', ')}`);
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
    bucketName: gcsFields.BUCKET_NAME || undefined,
    projectId: gcsFields.PROJECT_ID || undefined,
    gcsCredentials: gcsFields.GCS_SERVICE_ACCOUNT_JSON || undefined,
  };
}

async function runJob() {
  console.log('================================================================================');
  console.log('N1 Interface - Job Runner');
  console.log('================================================================================');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Environment: ${ENVIRONMENT}`);
  console.log(`  Skip uploads: ${SKIP_UPLOADS}`);
  console.log(`  Skip progress tracking: ${SKIP_PROGRESS_TRACKING}`);
  console.log('');

  let config: JobConfig;
  try {
    config = validateEnvironment();
    console.log(`✓ Environment validated`);
    console.log(`  User ID: ${config.userId}`);
    console.log(`  CHR ID: ${config.chrId}`);
    if (config.chrFilename) {
      console.log(`  CHR Filename: ${config.chrFilename}`);
    }
    console.log(`  Prompt: ${config.prompt.substring(0, 80)}...`);
    console.log('');
  } catch (error) {
    const errorInfo = classifyError(error as Error);
    console.error('✗ Environment validation failed:', error);
    process.exit(errorInfo.exitCode);
  }

  let realmPath: string | null = null;

  try {
    // Step 1: Initialize Gemini adapter
    await notifyProgress(config, 'initializing', `Setting up AI pipeline for report id ${config.chrId}`);
    console.log('[1/5] Initializing Gemini adapter...');
    const geminiAdapter = new GeminiAdapter();
    await geminiAdapter.initialize();
    console.log('✓ Gemini adapter ready');
    console.log('');

    // Step 2: Initialize Agentic Doctor
    console.log('[2/5] Initializing Agentic Doctor pipeline...');
    const agenticDoctorUseCase = new AgenticDoctorUseCase(geminiAdapter);
    agenticDoctorUseCase.setBillingContext({
      userId: config.userId,
      chrId: config.chrId,
    });
    await agenticDoctorUseCase.initialize();
    console.log('✓ Agentic Doctor ready');
    console.log('');

    // Step 3: Initialize N1 API adapter and fetch PDFs
    await notifyProgress(config, 'fetching_records');
    console.log('[3/5] Fetching PDFs from N1 API...');
    const n1ApiAdapter = new N1ApiAdapter(config.n1ApiBaseUrl, config.n1ApiKey);
    const fetchAndProcessUseCase = new FetchAndProcessPDFsUseCase(n1ApiAdapter, agenticDoctorUseCase);

    // Step 4: Process PDFs through pipeline
    await notifyProgress(config, 'analyzing');
    console.log('[4/5] Processing PDFs through multi-agent pipeline...');
    const generator = fetchAndProcessUseCase.execute(config.userId, config.prompt);

    for await (const event of generator) {
      if (event.type === 'step') {
        // Handle phase progress updates from AgenticDoctorUseCase
        const phaseName = 'name' in event ? event.name : '';
        const phaseStatus = 'status' in event ? event.status : '';

        if (phaseStatus === 'running' && phaseName && PHASE_PROGRESS_MAP[phaseName]) {
          console.log(`  📋 Phase: ${phaseName}`);
          // Send granular progress update to N1 API
          await notifyPhaseProgress(config, phaseName);
        } else if (phaseStatus === 'completed') {
          console.log(`  ✓ Phase completed: ${phaseName}`);
        } else if (phaseStatus === 'failed') {
          console.log(`  ✗ Phase failed: ${phaseName}`);
        }
      } else if (event.type === 'thought') {
        console.log(`  💭 ${'content' in event ? event.content : ''}`);
      } else if (event.type === 'log') {
        console.log(`  📝 ${'message' in event ? event.message : ''}`);
      } else if (event.type === 'result') {
        realmPath = 'url' in event ? event.url : '';
        console.log(`  ✓ Realm generated: ${realmPath}`);
      } else if (event.type === 'error') {
        const errorMsg = 'content' in event ? event.content : 'Unknown error';
        console.error(`  ✗ Error: ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }

    if (!realmPath) {
      throw new Error('No realm was generated');
    }

    await notifyProgress(config, 'generating_report');
    console.log('✓ Processing complete');
    console.log('');

    // Extract the full path to the HTML file
    // realmPath format: "/realms/<uuid>/index.html"
    const realmDir = path.join(process.cwd(), 'storage', 'realms', path.dirname(realmPath.replace('/realms/', '')));
    const htmlFilePath = path.join(realmDir, 'index.html');

    if (!fs.existsSync(htmlFilePath)) {
      throw new Error(`Generated HTML not found at: ${htmlFilePath}`);
    }

    let publicUrl = htmlFilePath; // Default to local path

    // Step 5: Upload to GCS (skip in development)
    if (SKIP_UPLOADS) {
      console.log('[5/5] Skipping GCS upload (ENVIRONMENT=development)');
      console.log(`  Local file: ${htmlFilePath}`);
    } else {
      await notifyProgress(config, 'uploading');
      console.log('[5/5] Uploading result to Google Cloud Storage...');
      const gcsAdapter = new GcsStorageAdapter(
        config.bucketName!,
        config.projectId!,
        config.gcsCredentials!
      );

      const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');

      // Build path: users/{userId}/chr/{chrId}/{filename}.html
      // Strip any existing extension (e.g., .pdf, .html) from chrFilename before adding .html
      const rawFilename = config.chrFilename || 'report';
      const filename = path.basename(rawFilename, path.extname(rawFilename)) || 'report';
      const gcsPath = `users/${config.userId}/chr/${config.chrId}/${filename}.html`;
      publicUrl = await gcsAdapter.uploadHtml(htmlContent, gcsPath);

      console.log(`✓ Uploaded to GCS: ${publicUrl}`);
    }
    console.log('');

    // Success - notify completion
    await notifyProgress(config, 'completed');
    console.log('================================================================================');
    console.log('Job completed successfully!');
    console.log(`Finished at: ${new Date().toISOString()}`);
    console.log(`Output: ${publicUrl}`);
    console.log('================================================================================');

    process.exit(0);

  } catch (error) {
    // Notify failure
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorInfo = classifyError(error as Error);

    await notifyProgress(
      config,
      'failed',
      errorMessage,
      errorInfo.userMessage,
      errorInfo.errorCode
    );

    console.error('');
    console.error('================================================================================');
    console.error('Job failed!');
    console.error(`Failed at: ${new Date().toISOString()}`);
    console.error('Error:', error);
    console.error('================================================================================');

    process.exit(errorInfo.exitCode);
  }
}

// Run the job
runJob();
