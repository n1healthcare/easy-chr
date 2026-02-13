/**
 * No-op Observability Adapter.
 *
 * Used when Langfuse is disabled or initialization fails.
 * Every method is a safe no-op — zero overhead, zero risk.
 */

import type {
  ObservabilityPort,
  TraceParams,
  SpanParams,
  GenerationParams,
  GenerationEndParams,
} from '../../application/ports/observability.port.js';

export class NoopObservabilityAdapter implements ObservabilityPort {
  async initialize(): Promise<boolean> { return false; }
  isEnabled(): boolean { return false; }

  createTrace(_params: TraceParams): string { return ''; }
  startSpan(_id: string, _params: SpanParams): void {}
  endSpan(_id: string, _metadata?: Record<string, unknown>): void {}

  startGeneration(_id: string, _params: GenerationParams): void {}
  endGeneration(_id: string, _params: GenerationEndParams): void {}

  scoreTrace(_traceId: string, _name: string, _value: number, _comment?: string): void {}

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
