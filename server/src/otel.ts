/**
 * OpenTelemetry initialization for easy-chr.
 *
 * Provides trace, metric, and log export to SigNoz via OTLP.
 * Controlled by OTEL_ENABLED env var.
 *
 * DEFENSIVE: OTEL initialization must NEVER crash the workflow.
 * If any dependency is missing or configuration is wrong, the service
 * runs without tracing. All exports are safe to call regardless of state.
 *
 * IMPORTANT: This file must be imported BEFORE any other application code
 * to ensure auto-instrumentation hooks are installed early.
 */

import { getLogger } from './logger.js';

let _initialized = false;
const logger = getLogger();

export function setupOtel(): boolean {
  if (_initialized) return true;

  try {
    const enabled = (process.env.OTEL_ENABLED ?? 'false').toLowerCase();
    if (!['true', '1', 'yes'].includes(enabled)) {
      return false;
    }

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
    if (!endpoint) {
      return false;
    }

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'easy-chr';

    // Dynamic imports wrapped in try-catch so missing packages don't crash
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
    const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { Resource } = require('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
    const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'unknown',
      'deployment.environment': process.env.ENVIRONMENT ?? 'unknown',
    });

    const traceExporter = new OTLPTraceExporter({
      url: endpoint,
    });
    const logExporter = new OTLPLogExporter({
      url: endpoint,
    });

    const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const spanProcessor = new BatchSpanProcessor(traceExporter, {
      maxQueueSize: 4096,
      maxExportBatchSize: 256,
      scheduledDelayMillis: 2000,
      exportTimeoutMillis: 60000,
    });
    const logProcessor = new BatchLogRecordProcessor(logExporter);

    const sdk = new NodeSDK({
      resource,
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
      instrumentations: [new HttpInstrumentation()],
    });

    sdk.start();

    // Graceful shutdown — best-effort, never throws
    const shutdownHandler = () => {
      sdk.shutdown().catch((err) => {
        if (err instanceof Error) {
          logger.warn(err, '[otel] Shutdown error (non-fatal)');
        } else {
          logger.warn({ error: String(err) }, '[otel] Shutdown error (non-fatal)');
        }
      });
    };
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);

    _initialized = true;
    logger.info({ serviceName, endpoint }, '[otel] Initialized');
    return true;
  } catch (e: unknown) {
    // DEFENSIVE: Never crash on OTEL failure
    if (e instanceof Error) {
      logger.warn(e, '[otel] Initialization failed (non-fatal)');
    } else {
      logger.warn({ error: String(e) }, '[otel] Initialization failed (non-fatal)');
    }
    return false;
  }
}
