import { LLMClientPort } from '../ports/llm-client.port.js';

export class SendChatUseCase {
  constructor(private readonly llmClient: LLMClientPort) {}

  async execute(message: string, sessionId: string): Promise<AsyncGenerator<string, void, unknown>> {
    // Here we could add logic to save the user message to a database, etc.
    return this.llmClient.sendMessageStream(message, sessionId);
  }
}
