import type { Config } from '../../../vendor/gemini-cli/packages/core/src/config/config.js';
import type { BillingContext } from '../../utils/billing.js';

export interface LLMStreamOptions {
  model?: string;
  tools?: any[];
  billingContext?: BillingContext;
}

export interface LLMClientPort {
  /**
   * Initialize the LLM client with necessary configuration/auth.
   */
  initialize(): Promise<void>;

  /**
   * Send a message to the LLM and get a streaming response.
   * @param message The user message to send
   * @param sessionId The session ID context
   * @param filePaths Optional array of paths to files to include in the context
   * @param options Optional configuration including model and tools
   * @returns An async generator yielding chunks of the response
   */
  sendMessageStream(message: string, sessionId: string, filePaths?: string[], options?: LLMStreamOptions): Promise<AsyncGenerator<string, void, unknown>>;

  /**
   * Get the underlying Config object for advanced agent operations.
   * This provides access to the gemini-cli Config which can be used
   * with LocalAgentExecutor for agentic workflows.
   */
  getConfig(billingContext?: BillingContext): Promise<Config>;
}
