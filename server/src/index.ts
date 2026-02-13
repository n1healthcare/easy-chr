// Initialize OTEL first (must be before other imports for auto-instrumentation)
import { setupOtel } from './otel.js';
try { setupOtel(); } catch { /* OTEL is optional — never crash */ }

import dotenv from 'dotenv';
import { createServer } from './adapters/http/server.js';
import { createStorageAdapterFromEnv } from './adapters/storage/storage.factory.js';
import { createObservabilityAdapter } from './adapters/langfuse/observability.factory.js';
import { getLogger, installConsoleBridge } from './logger.js';
import { getModelInventory } from './config.js';

dotenv.config();

const logger = getLogger();
installConsoleBridge(logger);

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
    const modelInventory = getModelInventory();
    if (Object.keys(modelInventory.ignoredEnvOverrides).length > 0) {
      logger.warn(
        { ignoredModelEnvOverrides: modelInventory.ignoredEnvOverrides },
        'Ignoring deprecated model env overrides due to defaults-only model policy',
      );
    }
    logger.info(
      {
        configuration: {
          runtime: {
            modelPolicy: modelInventory.policy,
            resolvedModels: modelInventory.resolvedModels,
            ignoredModelEnvOverrides: modelInventory.ignoredEnvOverrides,
            observability: {
              otelEnabled: process.env.OTEL_ENABLED ?? 'false',
              otelExporterOtlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
              otelServiceName: process.env.OTEL_SERVICE_NAME ?? 'easy-chr',
              observabilityEnabled: process.env.OBSERVABILITY_ENABLED ?? 'false',
            },
          },
        },
      },
      'Effective runtime configuration resolved',
    );

    // Initialize storage adapter based on environment
    const storage = createStorageAdapterFromEnv();
    const provider = process.env.STORAGE_PROVIDER ?? 'local';
    logger.info(`Storage provider: ${provider}`);

    // Initialize observability (Langfuse) — never crashes startup
    const observability = await createObservabilityAdapter();

    const server = await createServer(storage, observability);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    logger.info(`Server listening on port ${port}`);

    // Graceful shutdown for observability — best-effort, never throws
    const shutdownObservability = () => {
      observability.shutdown().catch(() => {});
    };
    process.on('SIGTERM', shutdownObservability);
    process.on('SIGINT', shutdownObservability);
  } catch (err) {
    logger.error(err, 'Server startup failed');
    process.exit(1);
  }
};

start();
