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
 * - PROMPT: User's analysis prompt (optional, defaults to generic prompt)
 * - N1_API_BASE_URL: N1 API backend URL
 * - N1_API_KEY: Authentication key for N1 API
 * - GEMINI_API_KEY: LiteLLM API key (for Gemini access)
 * - GOOGLE_GEMINI_BASE_URL: LiteLLM proxy URL (no /v1 suffix)
 * - BUCKET_NAME: GCS bucket for output storage
 * - PROJECT_ID: GCP project ID
 * - GCS_SERVICE_ACCOUNT_JSON: Service account credentials (JSON string)
 *
 * Environment-based feature flags:
 * - ENVIRONMENT: 'development' | 'staging' | 'production' (default: production)
 *   - development: Skips GCS upload and progress tracking
 *   - staging/production: Full pipeline with uploads and tracking
 */

import dotenv from 'dotenv';
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
  errorDetails?: string;
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

async function notifyProgress(
  config: { n1ApiBaseUrl: string; n1ApiKey: string; userId: string; chrId: string },
  step: keyof typeof PROGRESS_MAP,
  customMessage?: string,
  errorDetails?: string
): Promise<void> {
  const update = PROGRESS_MAP[step];
  if (!update) {
    console.log(`[Progress] Unknown step: ${step}`);
    return;
  }

  console.log(`[Progress] ${update.stage} (${update.progress}%): ${customMessage || update.message}`);

  // Skip API calls in development
  if (SKIP_PROGRESS_TRACKING) {
    console.log(`[Progress] Skipping API call (ENVIRONMENT=${ENVIRONMENT})`);
    return;
  }

  const payload: Record<string, unknown> = {
    report_id: config.chrId,
    user_id: config.userId,
    progress: update.progress,
    status: step === 'failed' ? 'ERROR' : (step === 'completed' ? 'completed' : 'in_progress'),
    message: customMessage || update.message,
    progress_stage: update.stage,
  };

  // Only include error field when there's an error (matches n1_api_client contract)
  if (errorDetails) {
    payload.error = errorDetails;
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

dotenv.config();

interface JobConfig {
  userId: string;
  chrId: string;
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
    prompt: process.env.PROMPT || 'Create a comprehensive health analysis and visualization of my medical records',
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
    console.log(`  Prompt: ${config.prompt.substring(0, 80)}...`);
    console.log('');
  } catch (error) {
    console.error('✗ Environment validation failed:', error);
    process.exit(1);
  }

  let realmPath: string | null = null;

  try {
    // Step 1: Initialize Gemini adapter
    await notifyProgress(config, 'initializing');
    console.log('[1/5] Initializing Gemini adapter...');
    const geminiAdapter = new GeminiAdapter();
    await geminiAdapter.initialize();
    console.log('✓ Gemini adapter ready');
    console.log('');

    // Step 2: Initialize Agentic Doctor
    console.log('[2/5] Initializing Agentic Doctor pipeline...');
    const agenticDoctorUseCase = new AgenticDoctorUseCase(geminiAdapter);
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
      if (event.type === 'thought') {
        console.log(`  💭 ${'content' in event ? event.content : ''}`);
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

      // Upload with CHR ID as filename
      const gcsPath = `reports/${config.chrId}/index.html`;
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
    await notifyProgress(config, 'failed', undefined, errorMessage);

    console.error('');
    console.error('================================================================================');
    console.error('Job failed!');
    console.error(`Failed at: ${new Date().toISOString()}`);
    console.error('Error:', error);
    console.error('================================================================================');

    process.exit(1);
  }
}

// Run the job
runJob();
