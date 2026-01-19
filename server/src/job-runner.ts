/**
 * N1 Interface - Job Runner (Ephemeral K8s Job Mode)
 *
 * This entry point runs as a Kubernetes Job spawned by forge-sentinel.
 * It fetches PDFs, processes them through the Agentic Doctor pipeline,
 * and uploads the result to Google Cloud Storage.
 *
 * Environment Variables (injected by forge-sentinel):
 * - USER_ID: User identifier for PDF fetching
 * - REPORT_ID: Unique identifier for this report generation
 * - PROMPT: User's analysis prompt (optional, defaults to generic prompt)
 * - N1_API_BASE_URL: N1 API backend URL
 * - N1_API_KEY: Authentication key for N1 API
 * - OPENAI_API_KEY: LiteLLM API key (for Gemini access)
 * - OPENAI_BASE_URL: LiteLLM proxy URL
 * - BUCKET_NAME: GCS bucket for output storage
 * - PROJECT_ID: GCP project ID
 * - GCS_SERVICE_ACCOUNT_JSON: Service account credentials (JSON string)
 * - MODEL: Model to use (e.g., "gemini-2.0-flash-exp")
 */

import dotenv from 'dotenv';
import { GeminiAdapter } from './adapters/gemini/gemini.adapter.js';
import { N1ApiAdapter } from './adapters/n1-api/n1-api.adapter.js';
import { AgenticDoctorUseCase } from './application/use-cases/agentic-doctor.use-case.js';
import { FetchAndProcessPDFsUseCase } from './application/use-cases/fetch-and-process-pdfs.use-case.js';
import { GcsStorageAdapter } from './adapters/gcs/gcs-storage.adapter.js';
import path from 'path';
import fs from 'fs';

dotenv.config();

interface JobConfig {
  userId: string;
  reportId: string;
  prompt: string;
  n1ApiBaseUrl: string;
  n1ApiKey: string;
  bucketName: string;
  projectId: string;
  gcsCredentials: string;
}

function validateEnvironment(): JobConfig {
  const required = {
    USER_ID: process.env.USER_ID,
    REPORT_ID: process.env.REPORT_ID,
    N1_API_BASE_URL: process.env.N1_API_BASE_URL,
    N1_API_KEY: process.env.N1_API_KEY,
    BUCKET_NAME: process.env.BUCKET_NAME,
    PROJECT_ID: process.env.PROJECT_ID,
    GCS_SERVICE_ACCOUNT_JSON: process.env.GCS_SERVICE_ACCOUNT_JSON,
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    userId: required.USER_ID!,
    reportId: required.REPORT_ID!,
    prompt: process.env.PROMPT || 'Create a comprehensive health analysis and visualization of my medical records',
    n1ApiBaseUrl: required.N1_API_BASE_URL!,
    n1ApiKey: required.N1_API_KEY!,
    bucketName: required.BUCKET_NAME!,
    projectId: required.PROJECT_ID!,
    gcsCredentials: required.GCS_SERVICE_ACCOUNT_JSON!,
  };
}

async function runJob() {
  console.log('================================================================================');
  console.log('N1 Interface - Job Runner');
  console.log('================================================================================');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  let config: JobConfig;
  try {
    config = validateEnvironment();
    console.log(`✓ Environment validated`);
    console.log(`  User ID: ${config.userId}`);
    console.log(`  Report ID: ${config.reportId}`);
    console.log(`  Prompt: ${config.prompt.substring(0, 80)}...`);
    console.log('');
  } catch (error) {
    console.error('✗ Environment validation failed:', error);
    process.exit(1);
  }

  let realmPath: string | null = null;

  try {
    // Step 1: Initialize Gemini adapter
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
    console.log('[3/5] Fetching PDFs from N1 API...');
    const n1ApiAdapter = new N1ApiAdapter(config.n1ApiBaseUrl, config.n1ApiKey);
    const fetchAndProcessUseCase = new FetchAndProcessPDFsUseCase(n1ApiAdapter, agenticDoctorUseCase);

    // Step 4: Process PDFs through pipeline
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

    console.log('✓ Processing complete');
    console.log('');

    // Step 5: Upload to GCS
    console.log('[5/5] Uploading result to Google Cloud Storage...');
    const gcsAdapter = new GcsStorageAdapter(
      config.bucketName,
      config.projectId,
      config.gcsCredentials
    );

    // Extract the full path to the HTML file
    // realmPath format: "/realms/<uuid>/index.html"
    const realmDir = path.join(process.cwd(), 'storage', 'realms', path.dirname(realmPath.replace('/realms/', '')));
    const htmlFilePath = path.join(realmDir, 'index.html');

    if (!fs.existsSync(htmlFilePath)) {
      throw new Error(`Generated HTML not found at: ${htmlFilePath}`);
    }

    const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');

    // Upload with report ID as filename
    const gcsPath = `reports/${config.reportId}/index.html`;
    const publicUrl = await gcsAdapter.uploadHtml(htmlContent, gcsPath);

    console.log(`✓ Uploaded to GCS: ${publicUrl}`);
    console.log('');

    // Success!
    console.log('================================================================================');
    console.log('Job completed successfully!');
    console.log(`Finished at: ${new Date().toISOString()}`);
    console.log(`Output URL: ${publicUrl}`);
    console.log('================================================================================');

    process.exit(0);

  } catch (error) {
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
