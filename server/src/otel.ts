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

let _initialized = false;

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
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { Resource } = require('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'unknown',
      'deployment.environment': process.env.ENVIRONMENT ?? 'unknown',
    });

    const traceExporter = new OTLPTraceExporter({
      url: endpoint,
    });

    const sdk = new NodeSDK({
      resource,
      traceExporter,
      instrumentations: [new HttpInstrumentation()],
    });

    sdk.start();

    // Graceful shutdown — best-effort, never throws
    const shutdownHandler = () => {
      sdk.shutdown().catch(() => {});
    };
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);

    _initialized = true;
    console.log(`[otel] Initialized: service=${serviceName}, endpoint=${endpoint}`);
    return true;
  } catch (e: unknown) {
    // DEFENSIVE: Never crash on OTEL failure
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[otel] Initialization failed (non-fatal): ${msg}`);
    return false;
  }
}
