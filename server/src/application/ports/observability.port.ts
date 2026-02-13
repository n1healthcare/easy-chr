/**
 * Observability Port — abstraction for pipeline tracing.
 *
 * Implementations:
 *   - LangfuseObservabilityAdapter (real tracing)
 *   - NoopObservabilityAdapter     (silent no-op when disabled)
 *
 * DEFENSIVE: Every call site wraps observability in try/catch.
 * A failing adapter must NEVER crash the pipeline.
 */

/** Metadata attached to a trace (one per pipeline run). */
export interface TraceParams {
  name: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/** Metadata attached to a span (one per pipeline phase). */
export interface SpanParams {
  name: string;
  traceId: string;
  metadata?: Record<string, unknown>;
}

/** Metadata attached to a generation (one per LLM call). */
export interface GenerationParams {
  name: string;
  traceId: string;
  parentSpanId?: string;
  model?: string;
  modelParameters?: Record<string, string | number | boolean | string[] | null>;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

/** Data recorded when a generation ends. */
export interface GenerationEndParams {
  output?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Approximate char count for streaming phases where exact tokens are unavailable. */
  outputCharCount?: number;
  /** Latency in milliseconds. */
  latencyMs?: number;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
}

export interface ObservabilityPort {
  /** Initialize the adapter. Returns false if disabled or credentials missing. */
  initialize(): Promise<boolean>;

  /** Whether tracing is actively enabled. */
  isEnabled(): boolean;

  // ---- Trace (1 per pipeline run) ----
  createTrace(params: TraceParams): string;

  // ---- Span (1 per phase) ----
  startSpan(id: string, params: SpanParams): void;
  endSpan(id: string, metadata?: Record<string, unknown>): void;

  // ---- Generation (1 per LLM call) ----
  startGeneration(id: string, params: GenerationParams): void;
  endGeneration(id: string, params: GenerationEndParams): void;

  // ---- Scoring ----
  scoreTrace(traceId: string, name: string, value: number, comment?: string): void;

  // ---- Lifecycle ----
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
