# Logging Standardization Plan

## Workflow
`easy-chr`

## Objective
Standardize server/job logging for production traceability: consistent structured logging, context-rich events, strict level discipline, startup config/model logging, full traceback capture, and SigNoz-compatible OTEL traces+logs.

## Current State Review
1. `server/src/logger.ts` provides a strong pino-based structured logger with PII sanitization and child logger support.
2. `server/src/job-runner.ts` uses child logger context for core flow, which is a good foundation.
3. Large portions of pipeline/use-case/service code still use direct `console.log/warn/error`, bypassing standardized logger and context.
4. `server/src/otel.ts` initializes trace export only; log export pipeline to SigNoz is missing.
5. Startup does not log a comprehensive resolved configuration/model snapshot.
6. Model settings are env-driven in `server/src/config.ts` and `server/src/adapters/gemini/gemini.adapter.ts`.
7. Exception logging consistency is mixed due to console usage and missing structured error objects in some paths.

## Recommendations
1. Make `logger.ts` the mandatory logging interface across all server runtime code.
2. Remove runtime `console.*` usage outside explicit low-level fallback internals.
3. Add startup configuration/model inventory log at entrypoint and job-runner start.
4. Move model selection to defaults-only internal config and deprecate env model overrides.
5. Add OTEL log export to complement existing trace export.

## Implementation Plan

### Phase 1: Logger Enforcement
1. Replace direct `console.*` calls in `server/src/**` (excluding tests/templates) with `getLogger()` or child loggers.
2. Add ESLint rule (`no-console`) with allowlist only in `logger.ts` and test files.
3. Ensure every major component gets a child logger with context (`user_id`, `chr_id`, `stage`, `phase`).

### Phase 2: Startup Traceability
1. Add a single startup log block in `server/src/index.ts` and `server/src/job-runner.ts` containing:
   - resolved environment,
   - storage provider,
   - observability flags,
   - resolved model defaults,
   - retry/throttle settings.
2. Ensure sensitive values are logged as `SET/UNSET` not raw secrets.

### Phase 3: Model Defaults-Only Migration
1. In `server/src/config.ts`, convert model fields to fixed defaults sourced from code constants.
2. Stop reading model IDs from env (`MARKDOWN_MODEL`, `INTERMEDIATE_MODEL`, `HTML_MODEL`, `DOCTOR_MODEL`, `GEMINI_MODEL`, `WEB_SEARCH_MODEL`) for runtime selection.
3. In `server/src/adapters/gemini/gemini.adapter.ts`, consume resolved defaults from config module only.
4. Add deprecation warnings for legacy env model vars and ignore their values.

### Phase 4: OTEL/SigNoz Logging Pipeline
1. Extend `server/src/otel.ts` to add OTEL log exporter setup (OTLP logs) in addition to traces.
2. Ensure logger output and OTEL log handler do not duplicate or drop records.
3. Add defensive handling for exporter failures (non-fatal warnings with stack).

### Phase 5: Error/Warning Standardization
1. Define severity rules:
   - `info` for normal milestones,
   - `warn` for recoverable degradation,
   - `error` for failed operations.
2. Ensure caught exceptions are logged with full error object/stack consistently.
3. Standardize operation-specific error fields in structured payloads.

### Phase 6: Validation
1. Add tests/lint checks for no console logging in runtime modules.
2. Add tests ensuring startup logs include config/model snapshot.
3. Add tests ensuring exception paths include stack metadata.
4. Validate SigNoz ingestion with trace-log correlation for one full job-runner flow.

## Acceptance Criteria
1. Runtime server/job code has no unmanaged `console.*` logging.
2. Startup emits full effective config/model snapshot.
3. Model selection is defaults-only, not env-routed.
4. Exception-caused warnings/errors include stack details.
5. SigNoz receives both logs and traces with correlation fields.
