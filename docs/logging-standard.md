# Logging Standard

## Scope
This workflow uses structured logging with `pino` and OpenTelemetry export for traces and logs to SigNoz.

## Required Patterns
- Use `getLogger()` / `createChildLogger()` in runtime modules.
- Use child logger context fields for correlation: `user_id`, `chr_id`, `report_id`, `stage`.
- Log one startup snapshot with effective runtime config, model inventory, and observability settings.
- Keep model routing defaults-only from `server/src/config.ts`; env model overrides are ignored.
- Log caught exceptions as an `Error` object (or include `error.stack`) for warning/error paths.

## Severity Rules
- `debug`: verbose progress/tool output.
- `info`: lifecycle milestones and successful operations.
- `warn`: recoverable degradation, fallback, retriable partial failures.
- `error`: operation failure, startup failure, terminal job failure.

## OTEL / SigNoz
- `setupOtel()` is fail-open: errors never crash service startup.
- Export traces and logs via OTLP endpoint when `OTEL_ENABLED=true`.
- OTEL initialization/shutdown failures are logged as non-fatal warnings with traceback.
