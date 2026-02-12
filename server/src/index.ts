// Initialize OTEL first (must be before other imports for auto-instrumentation)
import { setupOtel } from './otel.js';
try { setupOtel(); } catch { /* OTEL is optional — never crash */ }

import dotenv from 'dotenv';
import { createServer } from './adapters/http/server.js';
import { createStorageAdapterFromEnv } from './adapters/storage/storage.factory.js';
import { getLogger } from './logger.js';

dotenv.config();

const logger = getLogger();

// Convert standard OPENAI env vars to Gemini-specific ones
// This allows forge-sentinel to be agnostic about Gemini
// OPENAI_API_KEY takes priority - if present, it overwrites GEMINI_API_KEY
if (process.env.OPENAI_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.OPENAI_API_KEY;
} else if (!process.env.GEMINI_API_KEY) {
  // Neither is set - let the service throw the error
  logger.warn('Neither OPENAI_API_KEY nor GEMINI_API_KEY is set');
}

// OPENAI_BASE_URL takes priority - if present, it overwrites GOOGLE_GEMINI_BASE_URL
if (process.env.OPENAI_BASE_URL) {
  // Strip /v1 suffix for Gemini
  const baseUrl = process.env.OPENAI_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  process.env.GOOGLE_GEMINI_BASE_URL = baseUrl;
} else if (!process.env.GOOGLE_GEMINI_BASE_URL) {
  // Neither is set - let the service throw the error
  logger.warn('Neither OPENAI_BASE_URL nor GOOGLE_GEMINI_BASE_URL is set');
}

// Ensure non-job startup has a default service header for vendor gemini-cli paths.
// Per-request user/chr billing headers are attached in HTTP routes when provided.
if (!process.env.GEMINI_CLI_CUSTOM_HEADERS) {
  process.env.GEMINI_CLI_CUSTOM_HEADERS = 'x-service-name:workflow-easy-chr';
}

const start = async () => {
  try {
    // Initialize storage adapter based on environment
    const storage = createStorageAdapterFromEnv();
    const provider = process.env.STORAGE_PROVIDER ?? 'local';
    logger.info(`Storage provider: ${provider}`);

    const server = await createServer(storage);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${port}`);
  } catch (err) {
    logger.error(err, 'Server startup failed');
    process.exit(1);
  }
};

start();
