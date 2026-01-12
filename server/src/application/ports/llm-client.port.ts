import { Message } from '../../domain/types.js';

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
  sendMessageStream(message: string, sessionId: string, filePaths?: string[], options?: { model?: string, tools?: any[] }): Promise<AsyncGenerator<string, void, unknown>>;
}
