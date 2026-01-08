import { LLMClientPort } from '../../application/ports/llm-client.port.js';
import { Config, ConfigParameters } from '../../../vendor/gemini-cli/packages/core/src/config/config.js';
import { GeminiChat, StreamEventType } from '../../../vendor/gemini-cli/packages/core/src/core/geminiChat.js';
import { DEFAULT_GEMINI_MODEL } from '../../../vendor/gemini-cli/packages/core/src/config/models.js';
import { AuthType } from '../../../vendor/gemini-cli/packages/core/src/core/contentGenerator.js';
import path from 'path';
import fs from 'fs';

export class GeminiAdapter implements LLMClientPort {
  private config: Config | null = null;
  private chatSessions: Map<string, GeminiChat> = new Map();

  async initialize(): Promise<void> {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    console.log(`Using Gemini Model: ${model}`);

    const configParams: ConfigParameters = {
      sessionId: 'default-session', // This is just for config init
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: true,
      model: model,
    };

    this.config = new Config(configParams);
    await this.config.initialize();
    
    // Initialize authentication
    await this.config.refreshAuth(AuthType.USE_GEMINI);
    console.log('Gemini Adapter initialized successfully.');
  }

  async sendMessageStream(message: string, sessionId: string, filePaths?: string[], options?: { model?: string }): Promise<AsyncGenerator<string, void, unknown>> {
    if (!this.config) {
      throw new Error('GeminiAdapter not initialized');
    }

    let chat = this.chatSessions.get(sessionId);
    if (!chat) {
      chat = new GeminiChat(
        this.config,
        'You are a helpful assistant.',
        [], // Tools
        []  // History
      );
      this.chatSessions.set(sessionId, chat);
    }

    const modelConfigKey = {
      model: options?.model || this.config.getModel() || DEFAULT_GEMINI_MODEL
    };

    const controller = new AbortController();

    let parts: any[] = [{ text: message }];

    if (filePaths && filePaths.length > 0) {
      for (const filePath of filePaths) {
        // Better mime detection can be added later or inferred from extension
        const ext = path.extname(filePath).toLowerCase();
        let detectedMime = 'application/octet-stream';
        if (ext === '.pdf') detectedMime = 'application/pdf';
        if (ext === '.txt') detectedMime = 'text/plain';
        if (ext === '.md') detectedMime = 'text/plain';
        if (ext === '.json') detectedMime = 'application/json';
        if (ext === '.png') detectedMime = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') detectedMime = 'image/jpeg';

        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString('base64');

        parts.push({
          inlineData: {
            mimeType: detectedMime,
            data: base64Data
          }
        });
      }
    }

    const stream = await chat.sendMessageStream(
      modelConfigKey,
      parts,
      'user-prompt-id',
      controller.signal
    );

    async function* generator() {
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          const text = event.value.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield text;
          }
        }
      }
    }

    return generator();
  }
}
