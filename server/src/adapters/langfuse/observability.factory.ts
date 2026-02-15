/**
 * Observability Factory.
 *
 * Returns the real LangfuseObservabilityAdapter when enabled + credentials present,
 * otherwise the NoopObservabilityAdapter.
 *
 * DEFENSIVE: Factory itself never throws. On any error → noop.
 */

import type { ObservabilityPort } from '../../application/ports/observability.port.js';
import { LangfuseObservabilityAdapter } from './langfuse.adapter.js';
import { NoopObservabilityAdapter } from './noop-observability.adapter.js';
import { REALM_CONFIG } from '../../config.js';

export async function createObservabilityAdapter(): Promise<ObservabilityPort> {
  try {
    const cfg = REALM_CONFIG.langfuse;
    if (!cfg.enabled) {
      console.log('[observability] Disabled via OBSERVABILITY_ENABLED');
      return new NoopObservabilityAdapter();
    }

    if (!cfg.publicKey || !cfg.secretKey) {
      console.warn('[observability] Enabled but missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY — falling back to noop');
      return new NoopObservabilityAdapter();
    }

    const adapter = new LangfuseObservabilityAdapter({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.host,
    });

    const ok = await adapter.initialize();
    if (!ok) {
      console.warn('[observability] Langfuse init failed — falling back to noop');
      return new NoopObservabilityAdapter();
    }

    return adapter;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[observability] Factory error (non-fatal): ${msg}`);
    return new NoopObservabilityAdapter();
  }
}
