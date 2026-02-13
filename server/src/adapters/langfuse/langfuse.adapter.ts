/**
 * Langfuse Observability Adapter.
 *
 * Real implementation using the `langfuse` npm SDK (v3+).
 *
 * DEFENSIVE DESIGN:
 *   - initialize() performs auth_check — returns false on failure
 *   - Every public method is wrapped in try/catch
 *   - A Langfuse error NEVER propagates to the caller
 *   - flush()/shutdown() are best-effort with timeouts
 *
 * Pattern copied from otel.ts defensive approach.
 */

import Langfuse from 'langfuse';
import type {
  ObservabilityPort,
  TraceParams,
  SpanParams,
  GenerationParams,
  GenerationEndParams,
} from '../../application/ports/observability.port.js';

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export class LangfuseObservabilityAdapter implements ObservabilityPort {
  private client: Langfuse | null = null;
  private enabled = false;
  private config: LangfuseConfig;

  // Internal maps to track Langfuse objects by our string IDs
  private traces = new Map<string, ReturnType<Langfuse['trace']>>();
  private spans = new Map<string, ReturnType<ReturnType<Langfuse['trace']>['span']>>();
  private generations = new Map<string, ReturnType<ReturnType<Langfuse['trace']>['generation']>>();

  constructor(config: LangfuseConfig) {
    this.config = config;
  }

  async initialize(): Promise<boolean> {
    try {
      if (!this.config.publicKey || !this.config.secretKey) {
        console.warn('[langfuse] Missing credentials — disabling');
        return false;
      }

      this.client = new Langfuse({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl,
        requestTimeout: 10_000,
      });

      // Health check — verify credentials are valid with a lightweight API call
      await this.client.fetchTraces({ limit: 1 } as Parameters<typeof this.client.fetchTraces>[0]);

      this.enabled = true;
      console.log(`[langfuse] Initialized: host=${this.config.baseUrl}`);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[langfuse] Initialization failed (non-fatal): ${msg}`);
      this.client = null;
      this.enabled = false;
      return false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ---- Trace ----

  createTrace(params: TraceParams): string {
    if (!this.client) return '';
    try {
      const trace = this.client.trace({
        name: params.name,
        userId: params.userId,
        sessionId: params.sessionId,
        metadata: { service: 'easy-chr', ...params.metadata },
        tags: params.tags,
      });
      const traceId = trace.id;
      this.traces.set(traceId, trace);
      return traceId;
    } catch (e) {
      this.logError('createTrace', e);
      return '';
    }
  }

  // ---- Span ----

  startSpan(id: string, params: SpanParams): void {
    if (!this.client) return;
    try {
      const trace = this.traces.get(params.traceId);
      if (!trace) return;

      const span = trace.span({
        name: params.name,
        metadata: params.metadata,
      });
      this.spans.set(id, span);
    } catch (e) {
      this.logError('startSpan', e);
    }
  }

  endSpan(id: string, metadata?: Record<string, unknown>): void {
    try {
      const span = this.spans.get(id);
      if (!span) return;

      span.end({ metadata });
      this.spans.delete(id);
    } catch (e) {
      this.logError('endSpan', e);
    }
  }

  // ---- Generation ----

  startGeneration(id: string, params: GenerationParams): void {
    if (!this.client) return;
    try {
      // Prefer parent span if available, else trace
      const parent = params.parentSpanId
        ? this.spans.get(params.parentSpanId)
        : this.traces.get(params.traceId);
      if (!parent) return;

      const generation = parent.generation({
        name: params.name,
        model: params.model,
        modelParameters: params.modelParameters,
        input: params.input,
        metadata: params.metadata,
      });
      this.generations.set(id, generation);
    } catch (e) {
      this.logError('startGeneration', e);
    }
  }

  endGeneration(id: string, params: GenerationEndParams): void {
    try {
      const generation = this.generations.get(id);
      if (!generation) return;

      const meta: Record<string, string | number | boolean> = {};
      if (params.outputCharCount != null) meta.outputCharCount = params.outputCharCount;
      if (params.latencyMs != null) meta.latencyMs = params.latencyMs;

      generation.end({
        output: params.output,
        usage: params.usage
          ? {
              input: params.usage.promptTokens,
              output: params.usage.completionTokens,
              total: params.usage.totalTokens,
            }
          : undefined,
        level: params.level,
        statusMessage: params.statusMessage,
        metadata: meta,
      });
      this.generations.delete(id);
    } catch (e) {
      this.logError('endGeneration', e);
    }
  }

  // ---- Scoring ----

  scoreTrace(traceId: string, name: string, value: number, comment?: string): void {
    if (!this.client) return;
    try {
      this.client.score({
        traceId,
        name,
        value,
        comment,
      });
    } catch (e) {
      this.logError('scoreTrace', e);
    }
  }

  // ---- Lifecycle ----

  async flush(): Promise<void> {
    if (!this.client) return;
    try {
      await Promise.race([
        this.client.flushAsync(),
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
    } catch (e) {
      this.logError('flush', e);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await Promise.race([
        this.client.shutdownAsync(),
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
    } catch (e) {
      this.logError('shutdown', e);
    }
    this.client = null;
    this.enabled = false;
    this.traces.clear();
    this.spans.clear();
    this.generations.clear();
  }

  // ---- Internal ----

  private logError(method: string, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[langfuse] ${method} failed (non-fatal): ${msg}`);
  }
}
